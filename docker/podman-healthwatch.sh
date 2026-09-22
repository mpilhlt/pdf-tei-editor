#!/bin/bash

# Restart podman containers that podman's own healthcheck has marked unhealthy.
#
# Needed because podman's --health-on-failure=restart requires podman >= 4.3;
# on older podman (e.g. Ubuntu 22.04's 3.4.4) an unhealthy container is only
# reported via `podman ps`/`podman inspect`, never auto-recovered. This
# script does the restart instead and is meant to run periodically via the
# accompanying podman-healthwatch.timer systemd unit.

set -euo pipefail

for name in $(podman ps --filter health=unhealthy --format '{{.Names}}'); do
    echo "$(date -Is) [podman-healthwatch] Restarting unhealthy container: $name"
    podman restart "$name"
done
