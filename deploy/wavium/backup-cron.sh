#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Atrium contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Sauvegarde planifiee de Wavium (incident du 2026-11-24). Appelee par cron.
#
#   ./backup-cron.sh          # une sauvegarde + rotation
#
# Ecrit dans $DEST/<date UTC>/, verifie les sommes, puis ne garde que les
# $KEEP dernieres. Toute sortie va dans le journal ; cron n'envoie un mail
# que si le script sort en erreur.
#
# Le disque sdb (Toshiba MK2561GSYN, serie 32KPTE7CT) a ete ecarte le
# 2026-11-24 : il accepte les ecritures sans les rendre (bande de blocs
# defectueux 15692-21663 dans le systeme de fichiers, sauvegardes illisibles
# des le cache vide). La destination est desormais la carte SD. D ou la
# relecture verifiee apres chaque ecriture, et le refus de faire tourner les
# generations si la nouvelle sauvegarde ne se verifie pas.
set -euo pipefail
cd "$(dirname "$0")"

DEST=${WAVIUM_BACKUP_DEST:-/home/oxygen/wavium-backups}
KEEP=${WAVIUM_BACKUP_KEEP:-30}
LOG=${WAVIUM_BACKUP_LOG:-$DEST/backup.log}

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
say() { printf '%s %s\n' "$(ts)" "$*"; }

# Tout le corps du script journalise, erreurs comprises.
exec >>"$LOG" 2>&1 || { echo "backup-cron: journal $LOG inaccessible" >&2; exit 1; }

say "--- debut"

# 1. La destination doit porter son marqueur. Un point de montage vide (disque
#    debranche ou en panne) n'a pas le marqueur, donc on echoue bruyamment au
#    lieu d'ecrire ailleurs en croyant sauvegarder : c'est le piege exact qui a
#    coute les donnees le 2026-11-24. Ce test vaut pour un disque monte comme
#    pour un simple repertoire, contrairement a `mountpoint`.
if [ ! -f "$DEST/.wavium-backup-dest" ]; then
	say "ECHEC : $DEST/.wavium-backup-dest absent — destination non prete,"
	say "        rien n'est ecrit. Si le disque est debranche, c'est normal."
	exit 1
fi

# 2. L'instance doit tourner, sinon le dump serait vide.
if ! docker compose ps --status running --format '{{.Service}}' | grep -qx app; then
	say "ECHEC : le service app ne tourne pas"
	exit 1
fi

dir="$DEST/$(date -u +%Y%m%dT%H%M%SZ)"
say "sauvegarde -> $dir"
if ! ./backup.sh backup "$dir"; then
	say "ECHEC : backup.sh a echoue, $dir est incomplet"
	exit 1
fi

# 3. Relire ce qu'on vient d'ecrire, depuis LES PLATEAUX.
#    Lecon du 2026-11-24 : une verification faite juste apres l'ecriture relit
#    le cache du noyau, pas le disque. Deux sauvegardes ont ainsi ete declarees
#    bonnes sur un disque qui ne les rendait pas. On evince donc ces deux
#    fichiers du cache avant de verifier — seulement eux, pour ne pas vider
#    celui de toute la machine.
sync
python3 - "$dir" <<'PY' || say "note : eviction du cache impossible, la verification peut relire le cache"
import os, sys
for name in ("db.dump", "files.tar.gz"):
    path = os.path.join(sys.argv[1], name)
    fd = os.open(path, os.O_RDONLY)
    try:
        os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
    finally:
        os.close(fd)
PY
if ! ./backup.sh verify "$dir"; then
	say "ECHEC : $dir ne se verifie pas a la relecture, aucune rotation faite"
	exit 1
fi
say "verifiee : $dir ($(du -sh "$dir" | awk '{print $1}'))"

# 4. Rotation, seulement maintenant qu'une sauvegarde saine existe.
#    On ne compte que les repertoires qui portent un MANIFEST.
mapfile -t all < <(find "$DEST" -mindepth 2 -maxdepth 2 -name MANIFEST -printf '%h\n' | sort)
n=${#all[@]}
if [ "$n" -gt "$KEEP" ]; then
	drop=$((n - KEEP))
	say "rotation : $n sauvegardes, on en retire $drop (on garde $KEEP)"
	for d in "${all[@]:0:$drop}"; do
		say "  suppression $d"
		rm -rf -- "$d"
	done
else
	say "rotation : $n sauvegardes, rien a retirer (limite $KEEP)"
fi

say "--- fin, espace libre : $(df -h --output=avail "$DEST" | tail -1 | tr -d ' ')"
