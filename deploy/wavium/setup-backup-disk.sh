#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Atrium contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Prepare the Wavium backup disk (incident du 2026-11-24).
#
#   ./setup-backup-disk.sh            # montre ce qui serait fait
#   ./setup-backup-disk.sh --apply    # le fait
#
# Cible : le Toshiba MK2561GSYN de serie 32KPTE7CT, vierge et dedie a cet
# usage. Il est partitionne en GPT, formate en ext4 et monte sur /mnt/backup.
#
# Le disque est resolu PAR SON NUMERO DE SERIE, jamais par /dev/sdX. C'est la
# lecon de l'incident : la ligne fstab de /mnt/sdc visait un UUID, mais les
# lettres sdX bougent a chaque demarrage et le nom "/mnt/sdc" designait en
# realite /dev/sde. Un script qui formate /dev/sdb "parce que c'etait sdb la
# derniere fois" peut detruire le mauvais disque.
set -euo pipefail

SERIAL=32KPTE7CT
MODEL_WANT="TOSHIBA MK2561GSYN"
LABEL=wavium-backup
MOUNT=/mnt/backup
OWNER=${SUDO_USER:-$(id -un)}
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

# --- Resolution du disque par serie --------------------------------------

dev=$(lsblk -dno NAME,SERIAL | awk -v s="$SERIAL" '$2 == s {print "/dev/"$1}')
[ -n "$dev" ] || { say "ARRET : aucun disque de serie $SERIAL n'est branche."; exit 1; }
case "$(printf '%s\n' "$dev" | wc -l)" in
1) ;;
*) say "ARRET : plusieurs disques repondent a la serie $SERIAL : $dev"; exit 1;;
esac

model=$(lsblk -dno MODEL "$dev" | sed 's/ *$//')
[ "$model" = "$MODEL_WANT" ] || {
	say "ARRET : $dev porte la serie $SERIAL mais se declare \"$model\""
	say "        au lieu de \"$MODEL_WANT\". Refus par precaution."
	exit 1
}

say "Disque cible : $dev  ($model, serie $SERIAL)"
say "Taille       : $(lsblk -dno SIZE "$dev" | tr -d ' ')"
say ""

# --- Garde-fous destructifs ----------------------------------------------

# 1. Ne jamais toucher un disque monte.
if lsblk -no MOUNTPOINTS "$dev" | grep -q '[^[:space:]]'; then
	say "ARRET : $dev (ou une de ses partitions) est monte :"
	lsblk -no NAME,MOUNTPOINTS "$dev"
	exit 1
fi

# 2. Ne jamais toucher un membre de RAID.
if grep -q "$(basename "$dev")" /proc/mdstat 2>/dev/null; then
	say "ARRET : $dev apparait dans /proc/mdstat. Refus."
	exit 1
fi

# 3. Le disque doit etre vierge. S'il porte une signature, c'est qu'il n'est
#    pas celui qu'on croit, ou qu'il contient quelque chose.
sigs=$(sudo wipefs "$dev" 2>/dev/null | tail -n +2 || true)
if [ -n "$sigs" ]; then
	say "ARRET : $dev porte des signatures de systeme de fichiers :"
	printf '%s\n' "$sigs"
	say "        Ce script ne formate qu'un disque vierge. Verifier d'abord."
	exit 1
fi

# 4. Ne pas ecraser un montage deja en place.
if mountpoint -q "$MOUNT" 2>/dev/null; then
	say "ARRET : $MOUNT est deja monte. Rien a faire."
	exit 1
fi

say "Verifie : vierge, non monte, hors RAID."
say ""

# --- Partition et systeme de fichiers ------------------------------------

run sudo sgdisk --zap-all "$dev"
run sudo sgdisk --new=1:0:0 --typecode=1:8300 --change-name=1:"$LABEL" "$dev"
run sudo partprobe "$dev"

part="${dev}1"
# -m 1 : 1 % reserve au lieu de 5 %, inutile pour un disque de sauvegarde.
# -E lazy_itable_init=0 : tables initialisees tout de suite, pas pendant les
#    premieres ecritures, pour que la premiere sauvegarde ne rame pas.
run sudo mkfs.ext4 -L "$LABEL" -m 1 -E lazy_itable_init=0,lazy_journal_init=0 "$part"

# --- fstab et montage ----------------------------------------------------

run sudo mkdir -p "$MOUNT"

if [ "$APPLY" = "--apply" ]; then
	uuid=$(sudo blkid -s UUID -o value "$part")
	[ -n "$uuid" ] || { say "ARRET : pas d'UUID sur $part apres formatage."; exit 1; }
else
	uuid="<UUID-apres-formatage>"
fi

line="UUID=$uuid  $MOUNT  ext4  defaults,noatime,nofail  0  2"
say ""
say "Ligne fstab a ajouter :"
say "  $line"

if [ "$APPLY" = "--apply" ]; then
	sudo cp /etc/fstab /etc/fstab.bak-incident-20261124
	if grep -q "[[:space:]]$MOUNT[[:space:]]" /etc/fstab; then
		say "+ ligne $MOUNT deja presente dans fstab, laissee telle quelle"
	else
		printf '\n# Sauvegardes Wavium (incident du 2026-11-24). nofail : un disque de\n# sauvegarde absent ne doit jamais empecher la machine de demarrer.\n%s\n' \
			"$line" | sudo tee -a /etc/fstab >/dev/null
		say "+ ligne ajoutee a /etc/fstab (sauvegarde : /etc/fstab.bak-incident-20261124)"
	fi
	sudo mount "$MOUNT"
	sudo mkdir -p "$MOUNT/wavium"
	sudo chown "$OWNER":"$OWNER" "$MOUNT/wavium"
	say ""
	say "Monte :"
	df -h --output=source,size,used,avail,target "$MOUNT"
	say ""
	say "Les sauvegardes iront dans $MOUNT/wavium/, possede par $OWNER."
else
	say ""
	say "Rien n'a ete fait. Relancer avec --apply."
fi
