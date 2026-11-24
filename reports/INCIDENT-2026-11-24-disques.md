# Incident 2026-11-24 — Wavium hors ligne : deux pannes disque distinctes

> **CORRECTION du 2026-11-24 11h50 — des sauvegardes existaient.**
> Ce document a d'abord affirme qu'aucune sauvegarde de Wavium n'existait.
> C'etait faux, et l'erreur venait de la recherche : elle cherchait
> `*wavium*.sql*`, `*wavium*.dump`, `*nextcloud*.sql*` et `*atrium*.sql*`,
> alors que `backup.sh` nomme ses fichiers `db.dump` et `files.tar.gz`.
> Aucun de ces motifs ne pouvait les trouver.
>
> Trois sauvegardes saines sont dans `/home/oxygen/wavium-backups/` :
> `pre-v4-20261123T011530Z`, `pre-v41-20261123T112302Z` et
> `pre-v42-20261123T145144Z` (23 novembre 14h51, soit ~10 h avant la panne).
> Les trois ont ete verifiees apres eviction du cache : sommes sha256 bonnes.
> **Les donnees sont donc recuperables** — voir la section 7.

Diagnostic fait depuis le Pi, en lecture seule. Aucun conteneur demarre,
aucune ecriture sur les disques en cause.

## 1. Pourquoi Wavium ne repond plus

La stack `deploy/wavium` monte ses donnees par bind :

    wavium_db    -> /mnt/sdc/wavium/db
    wavium_html  -> /mnt/sdc/wavium/html
    wavium_redis -> /mnt/sdc/wavium/redis

`/mnt/sdc` n'est plus monte. Son disque, **/dev/sde (WDC WD3200BPVT, 320 Go,
port ata4)**, est tombe 43 s apres son attachement au boot de 00:58 UTC.
`fstab` porte `nofail` : le Pi a donc demarre sans lui, en silence. Caddy est
reste debout et renvoie des 502 sur https://100.122.210.35:8443.

Etat du disque : toute lecture avorte, y compris **le secteur 0 du
peripherique brut** (timeout 30 s, zero octet), meme apres rescan du lien SCSI.
Signature noyau : `exception Emask 0x0 SAct 0x0 SErr 0x0`, `failed command:
READ DMA`, `link is slow to respond`. SErr a 0 = la couche physique est saine,
c'est **le disque qui ne sert plus ses lectures** (tete / moteur).
SMART dit "PASSED" (0 realloue, 10 en attente) mais compte 113 erreurs ATA.
1867 evenements sur ata4 depuis le boot.

**Aucune sauvegarde de Wavium n'existe.** `/mnt/plutonium/backups` ne contient
qu'immich et un lot `pre-runtipi`. Aucun dump `*wavium*`/`*nextcloud*`/
`*atrium*` sur /mnt ni /home. `deploy/wavium/backups` n'existe pas.
Le depot a pourtant un `make backup` / `make restore` fonctionnel
(`deploy/backup.sh`, tache P6-3) : il n'a jamais ete planifie.

## 2. Plus urgent : le RAID1 perd des commandes

**/dev/sdd est membre de md0** (RAID1 avec sdc, monte sur /mnt/plutonium), la
ou sont les donnees personnelles irremplacables. Son port **ata3 a 656
evenements** depuis le boot :

    58 x  ata3: hard resetting link
    71 x  ata3: SATA link up 1.5 Gbps   (au lieu de 3.0 Gbps)
    36 x  ata3: SError: { PHYRdyChg PHYInt CommWake 10B8B Dispar LinkSeq DevExch }
    30 x  I/O error, dev sdd, ... Sense Key 0xb (ABORTED COMMAND)

`10B8B`, `Dispar`, `PHYRdyChg`, `DevExch` = erreurs d'encodage 8b/10b et de
disparite, c'est-a-dire **de l'integrite de signal**, et la negociation retombe
a 1.5 Gbps. Le SMART de sdd est irreprochable : 0 secteur realloue, 0 en
attente, 0 erreur CRC, en 2 ans de service.

=> Media sain + couche physique en echec = **cable ou connecteur SATA, pas le
disque**. A corriger : c'est la moitie d'un miroir de donnees critiques. Si sdc
flanche a son tour, md0 tombe.

Pour comparaison, sur le meme controleur (JMicron JMB58x, PCIe) :
ata2 (sdc) = 17 evenements, ata5 (sdf) = 6. Les deux ports sains.
Temperatures correctes : disques 32-38 C, SoC 60 C. Pas de sous-tension cote Pi
(`throttled=0xe0000` = thermique deja atteint, bit sous-tension absent).

## 3. Procedure materielle (Pi eteint)

Attention : eteindre le Pi coupe aussi la session Claude en cours.
Cette procedure est autonome.

1. Verifier que le RAID est propre avant d'y toucher :

       cat /proc/mdstat        # doit afficher [UU] et "active raid1"

2. Arreter proprement :

       sudo shutdown -h now

   Attendre l'extinction complete, puis couper l'alimentation du Pi et du HAT.

3. Reperer les disques par leur numero de serie (etiquette sur le disque) :

       sdc  = TOSHIBA MQ04ABD200  s/n 647RP0LKT   -> RAID, port sain
       sdd  = TOSHIBA MQ04ABD200  s/n 647RP135T   -> RAID, PORT FAUTIF (ata3)
       sde  = WDC WD3200BPVT      s/n WD-WX31EB1XAC47 -> disque Wavium mort (ata4)
       sdf  = WDC WD10SPZX        s/n WD-WXA1A98NAAZ1 -> /mnt/sda, port sain

4. **Le geste principal** : echanger les cables SATA de sdd (ata3) et de sde
   (ata4). Le disque sde est de toute facon a retirer, et sa couche physique
   est saine (SErr 0x0) : son cable est donc un bon donneur. Reclipser a fond
   des deux cotes, cote carte comme cote disque.
   Profiter de l'occasion pour reclipser aussi les connecteurs d'alimentation.

   Ce test est diagnostique : au reboot, si les erreurs `10B8B`/`Dispar` ont
   suivi le cable sur l'ancien port de sde, le cable est bien le coupable ;
   si elles restent sur sdd, c'est le connecteur du disque ou le port du HAT.

5. Remonter, rebrancher, demarrer, puis verifier :

       cat /proc/mdstat
       sudo journalctl -b | grep -cE 'ata3.*(hard resetting|SError)'
       sudo journalctl -b | grep -c 'dev sdd, sector'

   Zero (ou quasi) sur les deux derniers = cable repare.

6. Pour le disque Wavium (sde), une seule tentative vaut le coup : le
   rebrancher une fois reclipse et tester

       sudo timeout 60 dd if=/dev/sde of=/dev/null bs=512 count=1

   S'il repond, **ne rien monter** : faire d'abord une image complete avec
   ddrescue (a installer : `sudo apt install gddrescue`) vers un disque sain,
   puis travailler sur l'image. S'il ne repond pas, le disque est a considerer
   comme perdu.

## 3bis. Ou va aller Wavium (decide par le proprietaire, 2026-11-24)

**Sur /mnt/sda** (`/dev/sdf1`, WD10SPZX 1 To, port ata5), 442 Go libres,
SMART irreprochable (0 realloue, 0 en attente, 0 CRC, 11045 h) et seulement
6 evenements noyau sur son port. **Pas sur le RAID md0 / /mnt/plutonium**,
reserve aux donnees personnelles irremplacables, ni sur la carte SD.

Script pret, idempotent, qui ne demarre rien :

    deploy/wavium/move-data-to-sda.sh            # simulation
    deploy/wavium/move-data-to-sda.sh --apply    # bascule les 3 volumes bind

Il refuse d'agir si /mnt/sda n'est pas monte, si la stack tourne, si
/mnt/sdc est revenu (le disque repond : on recupere au lieu de repartir a
neuf), ou si la cible contient deja une base.

**A ne lancer qu'apres l'etape materielle**, et seulement si sde est confirme
perdu : creer l'instance neuve avant la tentative de recuperation obligerait a
resaisir la configuration des comptes mail pour rien.

## 3ter. Fait le 2026-11-24 : Wavium en ligne, et une sauvegarde qui existe

**Wavium a ete remis en service** sur /mnt/sda, sans intervention materielle,
sur consigne explicite du proprietaire (regle A1 ecartee par lui, sur sa
machine) :

- `move-data-to-sda.sh --apply` a repointe les trois volumes bind vers
  /mnt/sda/wavium. Les conteneurs arretes tenaient encore les volumes, d'ou
  un `docker compose rm -fsv` prealable (aucune donnee dans un conteneur).
- `.env` : `WAVIUM_IMAGE=atrium:v4.1` (09a611e703f5, l'image qui tournait
  reellement) et non le tag `atrium:wavium`, qui avait glisse vers une
  construction jamais mise en service. `WAVIUM_CRON_CPUS=0.75` pour que le
  travail de fond ne prenne pas le CPU a l'UI sur 4 coeurs partages.
- Instance **neuve et vide** : la configuration des comptes mail, l'historique
  de triage, les fichiers et l'agenda etaient sur le disque mort.
- Verifie : `/login` repond 200 en 74-105 ms (contre 1,5 a 11 s sur l'ancien
  disque mourant), `status.php` dit `installed:true`, compte `tungsten`
  present, apps mail/calendar/contacts actives, `/agent/mcp` repond 401.
- `pm.max_children` laisse a 6 malgre l'avertissement des anciens logs : il
  est figé dans l'image, et la contrainte de cette machine est la memoire
  (3,6 Go disponibles, swap entame), pas le nombre de workers.

**Le disque de sauvegarde : sdb, remis en service.** Le Toshiba MK2561GSYN
(serie 32KPTE7CT) a d'abord ete ecarte : un auto-test SMART lance avant de le
formater a repondu `Completed: read failure` au LBA 134249, a ses 24715 h
actuelles, alors que ses tests a 10991 h et a neuf passaient. Ses compteurs
CRC (116 millions) et Multi_Zone (358 millions) sont du bruit de passerelle
JMS578, pas des mesures ; les 1310 secteurs realloues, eux, sont reels.

Sur decision du proprietaire, il a ete remis en service en contournant le
defaut plutot qu'en l'ignorant :

- partition demarree a **1 GiB**, ce qui laisse la zone abimee (LBA 134249,
  soit ~68 Mo) entierement hors du systeme de fichiers ;
- `mkfs.ext4` a ecrit les tables d'inodes des 1856 groupes, repartis sur tout
  le disque, **sans une seule erreur** — premiere preuve que le reste du
  disque ecrit ;
- monte sur **/mnt/backup** par UUID avec `nofail` ;
- l'entree fstab de l'ancien /mnt/sdc (disque mort) a ete commentee, pour
  qu'elle n'induise plus en erreur ;
- premiere sauvegarde reelle : 61 Mo en 6,6 s, sommes sha256 verifiees a la
  relecture.

**La sauvegarde est planifiee** : `backup-cron.sh`, chaque nuit a 03h30, via
la crontab de `oxygen`. Il refuse d'ecrire si /mnt/backup n'est pas monte
(sinon il ecrirait sur la carte SD a travers un point de montage vide, le
piege exact de cet incident), refuse si le service `app` ne tourne pas,
relit et verifie la sauvegarde avant toute rotation, et garde les 30
dernieres. Journal : /mnt/backup/wavium/backup.log.

`setup-backup-disk.sh` reste dans le depot pour un futur disque dedie : il
resout sa cible **par numero de serie**, jamais par /dev/sdX, qui bouge d'un
demarrage a l'autre.

## 4. Ce qui est perdu si sde ne revient pas

Perdu : configuration des comptes mail, historique de classification/triage,
fichiers deposes dans Wavium, agenda et contacts propres a l'instance.

**Pas perdu : le courrier lui-meme**, qui reste sur le serveur IMAP d'Orange.
Une instance neuve le resynchronise.

## 5. A faire avant que la prochaine instance porte du vrai courrier

Planifier `make backup` (ou `deploy/wavium/backup.sh backup`) vers un support
distinct de celui des donnees. L'absence de sauvegarde est ce qui transforme
une panne disque en perte de donnees.

## 6. Piege a connaitre

Tant que `/mnt/sdc/wavium/db` est absent, le bind Docker echoue et le conteneur
refuse de demarrer : **c'est la protection actuelle**. Ne jamais creer ce
repertoire a la main pour "reparer le chemin". Vide, Postgres y ferait un
`initdb` et Wavium repartirait en instance neuve sur la carte SD, ce qui
ressemblerait a une perte totale et compliquerait la recuperation.

## 7. Les sauvegardes retrouvees, et ce que la restauration rend

Trois sauvegardes `backup.sh` saines, sur la carte SD, hors de tout disque en
panne :

| Sauvegarde | Date (UTC) | db.dump | files.tar.gz | Verifiee |
| --- | --- | --- | --- | --- |
| `pre-v4-20261123T011530Z`  | 2026-11-23 01:15 | 1 978 852 | 64 551 294 | oui |
| `pre-v41-20261123T112302Z` | 2026-11-23 11:23 | 2 018 516 | 64 551 541 | oui |
| `pre-v42-20261123T145144Z` | 2026-11-23 14:51 | 3 831 256 | 64 551 569 | oui |

Verification faite apres `posix_fadvise(POSIX_FADV_DONTNEED)` sur les deux
fichiers, donc relues depuis la carte et non depuis le cache.

La plus recente rend : la configuration des comptes mail, l'historique de
classification et de triage, les fichiers, l'agenda et les contacts, plus la
copie locale du courrier (`mail_bodies` est dans la base). Il manquera ce qui
est arrive entre le 23 a 14h51 et la panne du 24 a 01h15 — que la
resynchronisation IMAP ramenera pour le courrier.

Commande de restauration (elle REMPLACE la base et les fichiers de l'instance
actuelle, qui est vide et elle-meme sauvegardee sous
`20261124T114415Z`) :

    cd ~/wavium/deploy/wavium
    ./backup.sh restore /home/oxygen/wavium-backups/pre-v42-20261123T145144Z --yes

Versions compatibles : la sauvegarde porte `34.0.5.1`, l'instance aussi.

## 8. sdb : remis en service, puis ecarte sur preuve

Le Toshiba MK2561GSYN (serie 32KPTE7CT) a bien ete remis en service le
2026-11-24 : GPT, partition demarree a 1 GiB pour laisser hors du systeme de
fichiers le secteur illisible du LBA 134249, ext4, monte sur /mnt/backup,
225 Go disponibles. `mkfs.ext4` a ecrit les tables d'inodes des 1856 groupes
sans une erreur, et deux sauvegardes y ont ete ecrites puis verifiees.

**Ces deux verifications etaient trompeuses : elles relisaient le cache du
noyau.** Un balayage `badblocks` en lecture a trouve une bande de blocs
defectueux CONTIGUS *dans* le systeme de fichiers — blocs 15692 a 21663 de
4 Ko, soit ~24 Mo — et 485 erreurs noyau en quinze minutes. Apres
`drop_caches`, les deux sauvegardes etaient illisibles : `Input/output error`
sur `db.dump`, sommes en desaccord sur `files.tar.gz`.

Verdict : **ce disque accepte les ecritures et ne les rend pas.** Inutilisable
pour une sauvegarde. Un avertissement est pose dans
`/mnt/backup/LISEZ-MOI-DISQUE-NON-FIABLE.txt`.

Lecon integree a `backup-cron.sh` : la verification nocturne evince desormais
les deux fichiers du cache avant de relire, pour que la relecture touche
vraiment le support.

## 9. sde : pourquoi "mort" alors qu'il "devrait fonctionner"

Toutes les hypotheses logicielles ont ete testees et eliminees :

- **Verrou de securite ATA** : non. `hdparm -I` repond integralement et dit
  `not enabled`, `not locked`, `not frozen`.
- **Zone protegee HPA/DCO** : non. `hdparm -N` montre les 625142448 secteurs
  complets, et la requete elle-meme revient en ABORTED COMMAND.
- **Etat bloque a reinitialiser** : non. Un rescan du lien SCSI, puis une
  suppression complete du peripherique suivie d'une re-enumeration de `host5`
  (l'equivalent logiciel d'un rebranchement), l'ont fait revenir — et les
  lectures echouent toujours.
- **Degats limites aux premiers secteurs** : non. L'echec est identique a tous
  les LBA testes, et la signature est la meme a chaque fois.

Ce que le disque fait, en revanche :

- il repond a `IDENTIFY DEVICE` : modele, serie, firmware `01.01A01`,
  625142448 secteurs ;
- il negocie `UDMA/133` et `SErr` reste a `0x0` — la couche physique est saine ;
- sa temperature se lit en direct et monte (34 puis 35 °C) : il est alimente
  et tourne ;
- et il **annule toute commande touchant les plateaux** :
  `status: { DRDY ERR }`, `error: { ABRT }` sur chaque `READ DMA`. Son propre
  auto-test SMART ne demarre meme pas (`scsi error aborted command`).

`DRDY` signifie que le disque est pret ; `ABRT` qu'il refuse la commande. Ce
n'est pas une erreur de media — ce serait `UNC` avec le LBA fautif. Un disque
pret qui annule tout acces aux plateaux, c'est soit des tetes ou un preampli
hors service, soit une zone systeme illisible (le firmware ne peut plus
charger son translateur et refuse alors tout LBA utilisateur).

L'indice qui soutient la premiere explication : `G-Sense_Error_Rate` vaut
11266 en brut, et sa valeur normalisee est tombee a **001**, son pire niveau
possible. Ce disque a encaisse un tres grand nombre de chocs.

Ce qui reste a essayer, par ordre de cout :

1. **Une vraie coupure d'alimentation** (debranchement physique, pas un
   redemarrage : le HAT garde les disques alimentes). Certains disques
   relisent leur zone systeme apres un demarrage a froid. A faire pendant
   l'echange de cables de la section 3, puisque la machine sera ouverte.
2. **Recuperation professionnelle** (echange de tetes ou travail sur la zone
   systeme en salle blanche), quelques centaines d'euros. Desormais peu
   justifie : les sauvegardes de la section 7 rendent l'essentiel.
3. Le considerer comme perdu.


## 10. Les causes, etablies (2026-11-24, apres instrumentation)

Cette section remplace les hypotheses des sections 2 et 9. Elle s'appuie sur le
journal persistant du boot courant (`journalctl -k -b 0`, 12 h de trace), les
journaux d'erreur internes des disques et des tests de charge faits a la main.

### 10.1 sde (WD3200BPVT, WD-WX31EB1XAC47) : zone de service illisible

Ce que le disque fait apres un arret/relance du plateau (detachement SCSI puis
rescan de host5, soit la relance la plus profonde possible sans couper le 5 V) :

    ata4: SATA link up 3.0 Gbps (SStatus 123 SControl 300)
    ata4.00: configured for UDMA/133          <- pleine vitesse, lien parfait
    ata4.00: failed command: READ FPDMA QUEUED
    ata4.00: cmd 60/10:b8:00:00:00/...        <- LBA 0
    ata4.00: status: { DRDY ERR }  error: { ABRT }
    ata4.00: cmd 60/10:c0:10:00:00/...        <- LBA 16
    ata4.00: status: { DRDY ERR }  error: { ABRT }
    ata4: hard resetting link
    ata4: softreset failed (device not ready)

Le disque est donc alimente, tourne, negocie a 3.0 Gbps, et repond nominalement
a IDENTIFY, SMART, DCO (`DCO Checksum verified`), SECURITY (`not enabled / not
locked / not frozen`), HPA. Puis il **abandonne toute commande media**.

Le detail qui tranche : un secteur reellement defectueux renvoie **UNC**, une
erreur media (sense key 0x03, MEDIUM ERROR). sde renvoie **ABRT** (sense key
0x0b, ABORTED COMMAND) a tous les LBA testes, y compris 300 000 000. Un disque
qui signale "commande abandonnee" au lieu de "support illisible" ne sait plus
traduire LBA -> position physique.

Le SMART le confirme de l'interieur :

    197 Current_Pending_Sector    13     <- 13 secteurs qu'il n'arrive pas a lire
      5 Reallocated_Sector_Ct      0     <- il n'en a jamais remappe un seul
     10 Spin_Retry_Count           0     <- la mecanique demarre sans peine
      1 Raw_Read_Error_Rate   200/200    <- taux d'erreur normalise parfait
      9 Power_On_Hours          7890
        ATA Error Count           189    <- toutes a 7889 h, donc a la panne

13 secteurs en attente et zero realloue est une combinaison impossible pour un
disque sain : la reallocation est declenchee par une ecriture, et ici meme la
lecture est refusee. L'auto-test SMART, qui est execute par le firmware seul
sans aucun transfert vers l'hote, est lui aussi refuse (`Command "Execute SMART
Short self-test routine immediately" failed: scsi error aborted command`) : le
firmware n'arrive pas davantage que l'hote a atteindre ses plateaux.

=> **Panne de la zone de service** (micrologiciel/translateur sur les plateaux),
mode de defaillance connu de la famille WD Scorpio Blue. Ce n'est ni le cable
(`SErr 0x0` sur ata4, 0 evenement PHY), ni un verrou ATA, ni une HPA/DCO, ni de
simples secteurs defectueux.

**Consequence honnete : aucun moyen logiciel ne peut le reparer.** J'avais
annonce une ecriture de test (`hdparm --write-sector 0`) comme le levier
restant : c'etait faux, et je le corrige. Une ecriture serait abandonnee comme
les lectures, exactement pour la meme raison. Remettre sde en service demande un
outillage constructeur sur la zone de service (type PC-3000), c'est-a-dire un
laboratoire. Les donnees, elles, sont deja recuperees : voir section 7.

Seule tentative qui reste gratuite : une **vraie coupure du 5 V** quand la
machine sera ouverte. Le HAT garde les disques alimentes en continu, donc ce
firmware n'a jamais redemarre a froid depuis la panne. La probabilite est faible,
le cout est nul.

### 10.2 sde abimait aussi la machine, et c'est corrige

Tant que sde etait attache, le noyau resondait sa table de partition sans fin :

    ata4.00: failed command: READ DMA
    ata4.00: cmd c8/00:10:00:00:00/...   <- LBA 0
    ata4.00: cmd c8/00:10:10:00:00/...   <- LBA 16, puis on recommence

Une ligne par seconde, 739 lignes accumulees, `systemd-udevd` (pid 398) coince
en etat **D** sur /dev/sde, chaque autre commande vers ce port faisant la queue
derriere lui. C'est pour cela que `sg_turs`, `sg_reset` et l'auto-test restaient
bloques : le port etait en gestion d'erreur permanente.

Fait le 2026-11-24 : detachement du peripherique SCSI.

    echo 1 | sudo tee /sys/class/scsi_device/5:0:0:0/device/delete

Verifie : **0 nouvelle ligne ata4 en 40 s** (contre une par seconde), plus aucun
processus en etat D, Wavium intact (`status.php` 200 en 0,16 s, 6 conteneurs
sains). Le detachement ne survit pas a un redemarrage : au prochain boot la
boucle reprend. Le reglage definitif est de **debrancher physiquement sde** quand
la machine sera ouverte.

### 10.3 sdd (membre du RAID1) : le lien tombe sous charge, le media est sain

Correction de la section 2 sur un point : les 656 evenements sont bien ceux de
sdd (`ata3.00: ATA-10: TOSHIBA MQ04ABD200`, 30 x `I/O error, dev sdd`), mais ils
ne sont **pas permanents**. Repartition des resets de lien par heure :

    ata3 (sdd)   : 00h=1   01h=41   02h=16   10h=1   11h=1
    ata4 (sde)   : 00h=6   01h=6    11h=18   12h=12   (11h/12h = mes tests)
    ata2 (sdc)   : 01h=1
    ata5 (sdf)   : aucun

La tempete est concentree sur 01h-02h, puis s'arrete. Le superbloc de md0 porte
`Update Time: Tue Nov 24 11:05:15`, la seconde exacte du dernier reset ata3 :
depuis, /mnt/plutonium est inactif et le port est muet. md0 est monte `clean`,
2/2, **sans resync** : la charge venait des services qui lisent /mnt/plutonium,
pas du RAID.

Test de charge fait a la main le 2026-11-24, en lecture brute de /dev/sdd (donc
hors RAID, aucune ecriture), 3 x 500 Mo autour des secteurs qui echouaient a
01h17 (918-935 millions de secteurs) :

    offset 460 Go : 524 MB copied, 4.13 s, 127 MB/s
    offset 470 Go : 524 MB copied, 4.03 s, 130 MB/s
    offset 480 Go : 524 MB copied, 3.87 s, 136 MB/s
    nouvelles lignes ata3 : 0        nouveaux evenements PHY : 0

Le media est donc sain, et confirme par le SMART : 0 realloue, 0 en attente, 0
`UDMA_CRC_Error_Count`, `SMART overall-health: PASSED` en 3581 h.

Piege de mesure a retenir : les compteurs PHY du log GP 0x11 sont **volatils**,
remis a zero a chaque coupure d'alimentation du lien. Les lire apres 58 resets
de lien donne des zeros rassurants et faux. L'attribut non volatile a regarder
est le 199 (`UDMA_CRC_Error_Count`), et le journal noyau du boot.

=> Couche physique qui lache **sous debit soutenu**, media irreprochable :
cable ou connecteur SATA du port ata3. Le geste reste le meme (reseater ou
remplacer le cable de sdd), mais ce n'est pas une urgence : le RAID n'a jamais
ete degrade, et le defaut dort tant que /mnt/plutonium n'est pas sollicite.

**Sequelle a connaitre** : apres ses 58 resets, libata a bride le lien de sdd a
`SATA link up 1.5 Gbps (SStatus 113)` au lieu de 3.0 Gbps, et ne le remonte
jamais de lui-meme. A 136 Mo/s mesures, sdd **sature** ce lien bride. Un simple
redemarrage rend les 3.0 Gbps. Je n'ai pas force la remontee a chaud : il aurait
fallu detacher un membre actif du miroir qui porte les donnees
irremplacables, ce qui n'est pas un risque a prendre sans le proprietaire.

### 10.4 sdb (Toshiba MK2561GSYN, 32KPTE7CT) : usure du media, etendue

Cartographie rapide, lecture de 1 Mo en 40 points repartis sur les 232 Go :

    ...XX.........XX.X.XX.................XX
    lectures OK : 31 / 40    echecs : 9

Les echecs ne sont pas groupes : ils touchent le debut, le milieu et la fin du
plateau. Avec 1310 secteurs reallouees, un auto-test qui echoue a LBA 134249 et
une bande continue de blocs defectueux a 15692-21663 dans le systeme de
fichiers, le diagnostic est une **degradation generalisee du media**, pas un
defaut localise qu'on pourrait contourner. Il accepte les ecritures sans les
rendre. Ecarte definitivement, cf. section 8.

### 10.5 Les deux autres disques SATA, pour memoire

    sdc  (RAID1)   3570 h   0 realloue  0 en attente  0 CRC  PASSED
    sdd  (RAID1)   3581 h   0 realloue  0 en attente  0 CRC  PASSED
    sdf  (Wavium) 11048 h   0 realloue  0 en attente  0 CRC  PASSED

sdf, qui porte Wavium depuis la bascule, est le plus age des trois et pourtant
sans un seul defaut. Le choix de /mnt/sda tient.

## 11. Amendement : sdd n'avait probablement aucun defaut propre

Ajoute apres un test de charge fait une fois sde detache. Cette section corrige
la conclusion de la section 10.3, qui designait le cable de sdd.

Identite confirmee par deux chemins independants, parce que sdc et sdd sont le
meme modele et que le journal noyau ne les distingue pas :

    /dev/disk/by-id/ata-TOSHIBA_MQ04ABD200_647RP135T -> ../../sdd     (udev)
    sysfs : sdd  ata3  serie 647RP135T

Les liens by-id datent du boot de 00:58:30 et n'ont jamais ete recrees : la
correspondance tenait donc aussi pendant la tempete de 01h.

Sante de 647RP135T : `PASSED`, 0 realloue, 0 en attente, 0 `Offline_Uncorrectable`,
0 `UDMA_CRC_Error_Count`, 0 `Spin_Retry`, `Raw_Read_Error_Rate` 0, en 3582 h.
Et le miroir n'a rien perdu : `mismatch_cnt 0`, `degraded 0`, 0 erreur de
correction sur chaque membre, les deux `in_sync`, aucun evenement Fail ou
Degraded journalise. Les 30 erreurs de lecture de 01h ont ete resservies depuis
sdc de facon transparente.

### Le test

Lecture sequentielle soutenue des **deux** membres en parallele, en lecture
brute (hors RAID, aucune ecriture), 12 Go chacun a partir de l'offset 200 Go :

    sdc 647RP0LKT : 12582912000 bytes (13 GB) copied, 86.4 s, 146 MB/s
    sdd 647RP135T : 12582912000 bytes (13 GB) copied, 90.6 s, 139 MB/s
    nouvelles lignes ata2+ata3 : 0
    compteurs PHY non nuls     : 0 sur les deux disques

La panne ne se reproduit pas. Or une seule chose a change depuis le dernier
reset de ata3 (11:05:15) : **sde n'est plus attache**, donc il ne tente plus un
`hard resetting link` toutes les dix secondes, c'est-a-dire une relance de
plateau avec sa pointe de courant.

### Pourquoi c'est coherent

`UDMA_CRC_Error_Count = 0` est le detail decisif. Un cable qui degrade le signal
fait monter cet attribut (erreurs ICRC sur les FIS de donnees). A zero, avec
`PHYRdyChg + PHYInt + 10B8B + Dispar + LinkSeq`, le diagnostic n'est pas
"donnees abimees en transit" mais **"le lien a entierement disparu"**. Un lien
qui disparait sans erreur CRC designe une perte d'alimentation ou de contact,
pas un cable marginal.

sdc, sdd et sde partagent le meme controleur (JMicron JMB58x, PCIe
`0001:01:00.0`) et le meme rail 5 V du HAT. sdc a lui aussi pris 1 reset a 01h.
Les deux ports sains de 01h-02h etaient donc ata2 (1 reset) et ata3 (41), et le
port qui relancait son plateau en boucle etait ata4.

=> Hypothese retenue : **sdd encaissait les degats de sde.** Le cable n'est
probablement pas en cause. Geste revise : reseater le connecteur de sdd par
precaution quand la machine sera ouverte, mais ne pas changer le cable sans
raison.

Ce n'est pas une preuve : la charge de 01h-02h venait des services qui lisent
/mnt/plutonium et etait peut-etre plus aleatoire, ou melee d'ecritures (le
MQ04ABD200 est un disque **SMR gere par le disque**, qui peut bloquer longuement
pendant ses reecritures de bandes internes). Mais c'est une prediction
verifiable : maintenant que sde est detache, **ata3 doit rester muet**. A
surveiller apres la prochaine periode d'activite sur /mnt/plutonium :

    journalctl -k -b 0 | grep -cE 'ata3[:.]'

Rappel de la sequelle, inchangee : le lien de sdd reste bride a 1.5 Gbps. Les
139 Mo/s mesures saturent ce plafond (environ 150 Mo/s utiles). sdc, non bride,
lit a 146 Mo/s. Un redemarrage rend les 3.0 Gbps.

## 12. Etat des lieux du 2026-11-24 au soir (20h15-20h30 UTC)

Fait apres le redemarrage de 14h13 et la restauration de 18h17. Diagnostic en
lecture seule ; la seule ecriture de cette passe est un correctif de code, sur
la branche `night/V4-34`, pas encore applique a l'instance qui tourne.

### 12.1 Les lettres de disques ont toutes bouge

Le redemarrage les a reattribuees. Toute commande copiee des sections
precedentes viserait maintenant le mauvais disque. Correspondance par numero
de serie, la seule stable :

| Serie | Avant | Maintenant | Port | Role |
| --- | --- | --- | --- | --- |
| WD-WX31EB1XAC47 | sde | **sdf** | ata5 | l'ancien /mnt/sdc, donne pour mort |
| WD-WXA1A98NAAZ1 | sdf | **sdc** | ata2 | /mnt/sda, porte Wavium |
| 647RP135T | sdd | sdd | ata3 | membre md0 |
| 647RP0LKT | sdc | **sde** | ata4 | membre md0 |
| 32KPTE7CT | sdb | sdb | USB | /mnt/backup, non fiable |

`fstab` monte tout par UUID : les trois points de montage sont corrects malgre
la permutation. Le piege est pour l'humain et pour les scripts, pas pour le
noyau. `move-data-to-sda.sh` resout par montage, `setup-backup-disk.sh` par
numero de serie : les deux restent justes.

### 12.2 sde est revenu. Le disque "mort" lit a 73,7 Mo/s

C'etait le seul geste gratuit qui restait (section 10.1) : une vraie coupure du
5 V. Le redemarrage l'a faite, et le firmware a recharge sa zone de service.

    LBA 0          OK        LBA 300000000  OK
    LBA 1000       OK        LBA 625000000  OK
    LBA 100000     OK
    64 Mo sequentiels : 67108864 bytes, 0,91 s, 73,7 MB/s
    /dev/sdf1 : ext4, UUID 59faef99-d9e5-45c1-add6-f9060ba79d4a
                "Last mounted on /data", derniere ecriture 2026-11-24 00:43:03

Plus aucun ABRT, plus aucune boucle sur son port : 6 lignes ata5 sur tout le
boot. Le pronostic de la section 10.1 ("aucun moyen logiciel ne peut le
reparer, il faut un PC-3000") etait juste sur le fond et pessimiste sur
l'issue : le demarrage a froid suffisait.

L'etat du systeme de fichiers est `clean with errors`. Le disque reste suspect
(13 secteurs en attente, G-Sense normalise a 001) : a traiter comme une source
de lecture a copier, jamais comme un support a remettre en service.

Interet reel des donnees : faible, la restauration de `pre-v42` a rendu
l'essentiel. Il ne manquerait que la fenetre du 23 a 14h51 au 24 a 01h15, dont
le courrier est deja revenu par IMAP. Un montage en lecture seule
(`mount -o ro,noload`) dirait ce qui s'y trouve ; il attend l'accord du
proprietaire.

### 12.3 La prediction de la section 11 est fausse : ata3 retombe seul

La section 11 pariait que sde detache, ata3 resterait muet. Verifie sur ce
boot, ou l'ancien sde est non seulement rattache mais en bonne sante :

    Nov 24 17:13:21  ata3.00: failed command: READ FPDMA QUEUED  (x2)
    Nov 24 17:13:21  ata3: hard resetting link
    Nov 24 17:13:21  ata3: SATA link up 1.5 Gbps (SStatus 113 SControl 310)

Donc le defaut est propre a ata3. Et le compteur qui manquait a la section 11
a bouge : `199 UDMA_CRC_Error_Count` de sdd vaut **3**, alors qu'il etait a 0
apres deux ans de service. Des erreurs CRC signent une degradation du signal en
transit, c'est-a-dire le cable ou le connecteur — le diagnostic de la section
10.3, que la section 11 avait retire. **Le geste physique attendu reste le
meme : reasseoir ou remplacer le cable SATA de sdd (647RP135T, port ata3).**

Le miroir n'a rien perdu : `clean`, 2/2, `mismatch_cnt 0`, 0 erreur sur chaque
membre, les 14 erreurs d'E/S du boot resservies depuis l'autre disque. Le lien
est rebride a 1.5 Gbps depuis 17h13 et ne remontera pas sans redemarrage.

### 12.4 Ce qui marche

- **Wavium repond** : `/status.php` 200 en 20 ms (`installed:true`,
  34.0.5.1), `/login` 200, `/remote.php/dav/` 401, `/agent/mcp` 405 sur GET.
  6 conteneurs, `atrium:v4.1`, app et db sains. L'URL est
  `https://100.122.210.35:8443` (interface `wt0`) ; un test sur `localhost`
  echoue au handshake TLS et ne prouve rien — Caddy sert le certificat de
  `WAVIUM_DOMAIN` et n'a pas de politique pour un autre nom.
- **La restauration a bien eu lieu** : `pre-restore-20261124T181743Z` (dump de
  820 ko, l'instance vide) puis `pre-v42` restauree, puis
  `20261124T183356Z` (4,3 Mo). 1 compte mail, 3547 messages, 15 dossiers,
  3 comptes, l'agent `claude-mail`.
- **La resynchronisation IMAP tourne** : dernier sync 19h25, 10 mails arrives
  depuis l'horodatage de la sauvegarde.
- **La sauvegarde est planifiee et ecrit au bon endroit** : `backup-cron.sh`
  vise `/home/oxygen/wavium-backups` (carte SD) et non `/mnt/backup`, exige son
  marqueur `.wavium-backup-dest`, et relit hors cache. Le commentaire de la
  crontab, lui, dit encore `/mnt/backup` : il est trompeur et merite d'etre
  corrige.
- Les erreurs du journal applicatif (`mimetypelist.js`, un conflit de type du
  theming) datent toutes du 2026-11-20 et sont revenues avec la restauration du
  fichier de log. Rien de neuf depuis. `mimetypelist.js` existe.
- `make lint` et `make test` passent dans le stack dev (bun, 44 fichiers web /
  239 tests, PHPUnit 130 + 94, Daily Todo).

### 12.5 Ce qui etait casse, et qui ne venait pas de l'incident

**La classification n'a jamais tourne** : 3401 mails en attente, 0 classe. La
file portait sa cause :

    AI unreachable: cURL error 7: Failed to connect to 127.0.0.1 port 80
    for http://127.0.0.1/agent/v1/internal/ai/triage

`ATRIUM_SERVER_URL` valait `http://127.0.0.1:80` dans le bloc d'environnement
partage par `app` et `cron`. Le worker de triage tourne dans `cron`, ou rien
n'ecoute sur le port 80. Mesure depuis les conteneurs : `app:80/status.php`
repond 200 depuis les deux, `127.0.0.1:80` repond 000 depuis `cron`.

Ce n'est pas une sequelle de la panne : la sauvegarde `pre-v42` du 23 a 14h51
contenait deja 3398 lignes en attente, 0 classee et 0 fournisseur IA.

Corrige sur `night/V4-34` : les deux stacks de production nomment desormais
`app`, et `server/ai/triage-stack.test.ts` tient l'invariant. La correction ne
prendra effet qu'une fois le conteneur `cron` recree.

**Deuxieme cause, qui demande une decision** : `oc_atrium_ai_providers` est
vide. Avec la bonne URL, la route repond 409 `not_configured` et le worker
laisse chaque mail `pending` avec "No AI for mail triage. Add one in
Settings > AI." — aucun essai compte, rien de parque, rien de perdu. Ajouter un
fournisseur demande une vraie cle et une decision de depense.
