# Oracle Cloud

This recipe implements the normative
[`Supported Deployment Standard`](../SUPPORTED-DEPLOYMENT.md); read and use its complete acceptance
checklist. Provider names and shapes below are examples, not a capacity guarantee.

## Create the VM

Create a Compute instance with at least 2 vCPU and 4 GB RAM as the supported starting point. Choose
a Canonical Ubuntu 24.04 image whose architecture matches the shape. With a flexible shape, account
for that shape's OCPU-to-vCPU mapping when selecting the OCPU count, set at least 4 GB RAM, and then
qualify final production sizing with representative load tests.

```bash
oci compute instance launch --availability-domain <availability-domain> --compartment-id <compartment-ocid> --shape <shape> --shape-config <shape-config-json> --subnet-id <subnet-ocid> --image-id <ubuntu-24.04-image-ocid> --ssh-authorized-keys-file <public-key-path> --display-name <vm-name>
```

Use Oracle's [instance launch guide](https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/launchinginstance.htm)
to obtain the current regional image OCID. Attach a block volume and mount it at Docker's
`/var/lib/docker` data root. Persist the mount in `/etc/fstab` before installing or starting Docker;
the shipped Compose profile does not include an arbitrary host bind-mount override. Before install, verify at least 10 GiB free on both the checkout
and Docker-root filesystems; then size for the customer's database/WAL, uploads, image/cache,
restore, and backup plan. Keep SQLite WAL on the guest's real local filesystem, not File Storage
Service or another shared filesystem.

For direct Caddy, allow inbound TCP 80/443 in both VCN rules and the instance firewall; UDP 443 may
also be allowed for the shipped HTTP/3 mapping. Keep SSH limited to operator access, and point
A/AAAA records at the public IP. Alternatively, follow the
[dedicated outbound Tunnel recipe](front-door.md), keep public web ingress closed, and use
`install.sh --cloudflare-tunnel`.

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
