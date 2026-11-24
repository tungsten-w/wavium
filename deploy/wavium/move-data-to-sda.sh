#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Atrium contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Incident 2026-11-24 : le disque de donnees de Wavium (/dev/sde, monte sur
# /mnt/sdc) est mort. Ce script repointe les trois volumes bind de la stack
# vers /mnt/sda (/dev/sdf1, 1 To WD SATA, port sain) et ne demarre rien.
#
#   ./move-data-to-sda.sh            # montre ce qui serait fait
#   ./move-data-to-sda.sh --apply    # le fait
#
# Il ne detruit aucune donnee : les volumes Docker vises ne contiennent que
# la *definition* du bind, les donnees vivaient sur /mnt/sdc.
set -euo pipefail
cd "$(dirname "$0")"

NEW_ROOT=/mnt/sda/wavium
APPLY=${1:-}

say() { printf '%s\n' "$*"; }
run() {
	if [ "$APPLY" = "--apply" ]; then
		say "+ $*"
		"$@"
	else
		say "  (simulation) $*"
	fi
}

# --- Garde-fous -----------------------------------------------------------

# 1. Le disque cible doit etre monte, sinon on recreerait le meme piege :
#    un bind vers un chemin absent, ou pire vers un repertoire vide sur la
#    carte SD, ou Postgres ferait un initdb silencieux.
if ! mountpoint -q /mnt/sda; then
	say "ARRET : /mnt/sda n'est pas monte. Verifier /dev/sdf1 et fstab."
	exit 1
fi

# 2. Ne jamais ecraser une instance qui tourne.
if docker ps --format '{{.Names}}' | grep -qE '^wavium-(app|db|cron)-1$'; then
	say "ARRET : la stack tourne. L'arreter d'abord :"
	say "        docker compose stop app cron db redis"
	exit 1
fi

# 3. Si /mnt/sdc est revenu (disque reanime), ne rien faire : ses donnees
#    valent mieux qu'une instance neuve, et c'est une decision humaine.
if mountpoint -q /mnt/sdc; then
	say "ARRET : /mnt/sdc est monte a nouveau -- le disque repond."
	say "        Ne pas basculer : faire d'abord une image ddrescue, puis"
	say "        restaurer. Voir reports/INCIDENT-2026-11-24-disques.md."
	exit 1
fi

# 4. Si la cible contient deja une base, c'est qu'on est deja passe par ici.
if [ -s "$NEW_ROOT/db/PG_VERSION" ]; then
	say "ARRET : $NEW_ROOT/db contient deja une base Postgres."
	say "        Rien a faire, ou restaurer via ./backup.sh restore."
	exit 1
fi

say "Bascule des donnees Wavium vers $NEW_ROOT"
say "Espace disponible : $(df -h --output=avail /mnt/sda | tail -1 | tr -d ' ')"
say ""

# --- Les repertoires ------------------------------------------------------
# Laisses a root: les deux images (postgres, nextcloud) demarrent en root et
# chownent elles-memes leur repertoire de donnees.
for d in db html redis; do
	run sudo mkdir -p "$NEW_ROOT/$d"
done
say ""

# --- Les conteneurs arretes -----------------------------------------------
# Un conteneur arrete tient toujours une reference sur ses volumes, ce qui
# bloque `docker volume rm`. Les supprimer ne touche aucune donnee : elle vit
# dans le bind, pas dans le conteneur. `docker compose up` les recreera.
stopped=$(docker ps -a --filter label=com.docker.compose.project=wavium \
	--filter status=exited --format '{{.Names}}' | tr '\n' ' ')
if [ -n "${stopped// /}" ]; then
	say "Conteneurs arretes a retirer : $stopped"
	run docker compose rm -fsv app cron db redis
	say ""
fi

# --- Les volumes ----------------------------------------------------------
# Les labels compose sont obligatoires : sans eux, `docker compose up` ne
# reconnait pas le volume comme le sien et refuse de demarrer.
for d in db html redis; do
	run docker volume rm "wavium_$d"
	run docker volume create \
		--driver local \
		--opt type=none \
		--opt o=bind \
		--opt "device=$NEW_ROOT/$d" \
		--label com.docker.compose.project=wavium \
		--label com.docker.compose.volume="$d" \
		"wavium_$d"
done
say ""

# --- .env -----------------------------------------------------------------
# Purement informatif (page "Vos donnees" des reglages), mais il doit dire
# la verite sur l'emplacement reel.
run sed -i.bak-incident-20261124 \
	-e "s|^WAVIUM_HOST_DATA=.*|WAVIUM_HOST_DATA=$NEW_ROOT/html/data|" \
	-e "s|^WAVIUM_HOST_DB=.*|WAVIUM_HOST_DB=$NEW_ROOT/db|" \
	-e "s|^# Donnees sur le disque SATA fixe /mnt/sdc.*|# Donnees sur /mnt/sda (/dev/sdf1) depuis l'incident du 2026-11-24 : l ancien disque /mnt/sdc (/dev/sde) est mort.|" \
	.env
say ""

if [ "$APPLY" != "--apply" ]; then
	say "Rien n'a ete fait. Relancer avec --apply."
	exit 0
fi

say "Fait. Les volumes pointent maintenant vers $NEW_ROOT :"
for d in db html redis; do
	printf '  wavium_%-6s -> %s\n' "$d" \
		"$(docker volume inspect "wavium_$d" --format '{{index .Options "device"}}')"
done
say ""
say "La stack n'est PAS demarree. Pour creer l'instance neuve :"
say "    docker compose --env-file .env up -d"
say ""
say "ATTENTION a l'image. Les conteneurs tournaient sur l'image"
say "09a611e703f5 (atrium:v4.1). Le tag atrium:wavium pointe aujourd'hui sur"
say "une construction plus recente et jamais mise en service (f4da0c11e4a3)."
say "Pour repartir sur ce qui tournait, mettre dans .env :"
say "    WAVIUM_IMAGE=atrium:v4.1"
say ""
say "Et avant que cette instance porte du vrai courrier : planifier"
say "    ./backup.sh backup"
say "vers un support distinct. C'est son absence qui a transforme une panne"
say "disque en perte de donnees."
