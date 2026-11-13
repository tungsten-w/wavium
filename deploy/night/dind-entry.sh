#!/bin/sh
# docker:dind entrypoint wrapper for night runs: before dockerd starts, cut
# this sidecar (and every container it runs) off from the local network.
# Rules live in the sidecar's own network namespace: the host is untouched.
# Allowed: loopback, the sidecar's own subnets (Docker networks it creates
# use 172.x ranges and are allowed via the docker bridge interfaces), the
# internet. Refused: RFC1918 ranges, link-local, CGNAT (NetBird/Tailscale).
set -eu
own=$(ip -4 -o addr show eth0 | awk '{print $4}')
for chain in OUTPUT FORWARD; do
	iptables -A "$chain" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
	iptables -A "$chain" -d "$own" -j ACCEPT
	iptables -A "$chain" -o docker0 -j ACCEPT
	iptables -A "$chain" -o br-+ -j ACCEPT
	for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10; do
		iptables -A "$chain" -d "$net" -j REJECT
	done
done
exec dockerd-entrypoint.sh "$@"
