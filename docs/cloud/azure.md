# Azure

This recipe implements the normative
[`Supported Deployment Standard`](../SUPPORTED-DEPLOYMENT.md); read and use its complete acceptance
checklist. Provider names and sizes below are examples, not a capacity guarantee.

## Create the VM

Create an Ubuntu 24.04 LTS VM with at least 2 vCPU and 4 GB RAM as the supported starting point.
Choose an image that matches the selected VM family's architecture. One x86_64 example is
`Standard_D2s_v5`, which has 2 vCPU and 8 GB RAM; choose another size that meets both minimums if it
is unavailable, then qualify final production sizing with representative load tests.

```bash
az vm create --resource-group <resource-group> --name <vm-name> --image Ubuntu2404 --size <vm-size> --admin-username <admin-user> --ssh-key-values <public-key-path> --public-ip-sku Standard
```

Follow Microsoft's [Linux VM CLI guide](https://learn.microsoft.com/azure/virtual-machines/linux/quick-create-cli).
Attach a managed data disk and mount it at Docker's `/var/lib/docker` data root. Keep the mount
persistent in `/etc/fstab` before installing or starting Docker; the shipped Compose profile does
not include an arbitrary host bind-mount override. Before install,
verify at least 10 GiB free on both the checkout and Docker-root filesystems; then size for the
customer's database/WAL, uploads, image/cache, restore, and backup plan. Keep SQLite WAL on the
guest's real local filesystem, not Azure Files or another shared filesystem.

For direct Caddy, allow inbound TCP 80/443 in the network security group; UDP 443 may also be
allowed for the shipped HTTP/3 mapping. Do not add application-port rules. Point the domain's A
record, and AAAA when IPv6 is configured, at the VM public address. Alternatively, follow the
[dedicated outbound Tunnel recipe](front-door.md), keep public web ingress closed, and use
`install.sh --cloudflare-tunnel`.

Enable and monitor host time synchronization. Permit approved DNS/time egress; HTTPS for install,
configured model-provider APIs, and administrator-requested public-page fetches; SMTP when
configured; and ACME traffic from Caddy in direct mode or the dedicated Tunnel transport in tunnel
mode. Restrict SSH to the operator network.

## Install

SSH into the VM. Install Docker Engine and its Compose plugin using Docker's
[Ubuntu instructions](https://docs.docker.com/engine/install/ubuntu/) (the documented apt
repository method, not a curl-pipe-shell command). Add the deployment user to the `docker` group
and start a new login shell, or run the installer with `sudo`. Then:

```bash
git clone <repository-url> <repository-directory>
cd <repository-directory>
./install.sh --domain <app-domain> --email <acme-email> --workspace-name <workspace-name> --admin-email <owner-email>
```

Complete and retain every gate in the
[`Supported Deployment Standard`](../SUPPORTED-DEPLOYMENT.md#8-acceptance-gates), including load
qualification and a non-production restore exercise, before customer hand-off.
