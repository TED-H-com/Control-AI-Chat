# AWS

This recipe implements the normative
[`Supported Deployment Standard`](../SUPPORTED-DEPLOYMENT.md); read and use its complete acceptance
checklist. Provider names and sizes below are examples, not a capacity guarantee.

## Create the VM

Create an EC2 VM with 2 vCPU and 4 GB RAM as the supported starting point. Canonical Ubuntu Server
24.04 LTS AMIs are known to
work on x86_64 and ARM64 (Graviton); the AMI architecture must match the instance family. One
example is `t3.medium` for x86_64; choose an equivalent class where needed, then qualify final
production sizing with representative load tests.

```bash
aws ec2 run-instances --image-id <ubuntu-24.04-ami-id> --instance-type <instance-type> --key-name <key-name> --security-group-ids <security-group-id> --subnet-id <subnet-id> --block-device-mappings <block-device-mapping-json>
```

Use AWS's [EC2 launch guide](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/launching-instance.html)
to select the current regional Canonical AMI. Attach an EBS volume and mount it at Docker's
`/var/lib/docker` data root. Make the mount persistent in `/etc/fstab` before installing or starting
Docker; the shipped Compose profile does not include an arbitrary host bind-mount override. Before install, verify at least 10 GiB free on both the checkout
and Docker-root filesystems; then size for the customer's database/WAL, uploads, image/cache,
restore, and backup plan. Keep SQLite WAL on the guest's real local filesystem, not EFS or another
shared filesystem.

For direct Caddy, allow inbound TCP 80/443 only for the application; UDP 443 may also be allowed for
the shipped HTTP/3 mapping. Keep SSH limited to the operator network, and point A/AAAA records at
the public address. Alternatively, follow the [dedicated outbound Tunnel recipe](front-door.md),
keep public web ingress closed, and use `install.sh --cloudflare-tunnel`.

Enable and monitor host time synchronization. Permit approved DNS/time egress; HTTPS for install,
configured model-provider APIs, and administrator-requested public-page fetches; SMTP when
configured; and ACME traffic from Caddy in direct mode or the dedicated Tunnel transport in tunnel
mode.

## Install

SSH into the VM. Install Docker Engine and Compose using Docker's
[Ubuntu instructions](https://docs.docker.com/engine/install/ubuntu/) via its documented apt
repository. Add the deployment user to the `docker` group and start a new login shell, or run the
installer with `sudo`. Then:

```bash
git clone <repository-url> <repository-directory>
cd <repository-directory>
./install.sh --domain <app-domain> --email <acme-email> --workspace-name <workspace-name> --admin-email <owner-email>
```

Complete and retain every gate in the
[`Supported Deployment Standard`](../SUPPORTED-DEPLOYMENT.md#8-acceptance-gates), including load
qualification and a non-production restore exercise, before customer hand-off.
