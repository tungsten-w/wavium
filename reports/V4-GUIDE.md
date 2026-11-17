# Wavium v4 — guide pour tester

Démo locale : `ssh -L 8302:localhost:8302 sodium@gallium` puis http://localhost:8302
(alice / alice-demo-pass, bob / bob-demo-pass). Le téléphone est **simulé** :
rien ne part chez Google.

## 1. Messages (SMS / RCS du téléphone)

1. Menu du haut › **Messages** › « Show the QR code ». Le QR code s'affiche
   (une ligne le « scanne »). Le faux téléphone s'appaire tout seul en 3 s :
   « Your phone is linked » › « Open my texts ».
2. Ouvre une conversation, écris, **Entrée** : la bulle monte depuis la zone
   de saisie, le faux téléphone répond « 👍 » 2 s après.
3. La conversation « Bank » contient un code : il porte l'étiquette 🔒 code,
   et **les agents ne le voient pas** (réglable dans *Phone & agents*).
4. Recherche : la barre du haut trouve aussi les SMS (groupe « Messages »).
5. Tableau de bord › carte *Today* : « Texts » liste les SMS qui attendent
   une réponse.

Avec ton vrai téléphone (plus tard) : en production,
`docker compose --profile messages up -d --build` dans `deploy/wavium`,
puis Messages › Link my phone, et scanne avec Google Messages ›
Association d'appareils. Ce n'est pas une API officielle de Google.

## 2. Mail : « Why is this here? »

Ouvre un mail : sous l'expéditeur, une phrase dit pourquoi il est là
(catégorie, sûr à X %, attend une réponse…). **Wrong?** › choisis la bonne
catégorie › *Fix it* : le mail change tout de suite, et les prochains mails
de cet expéditeur seront classés comme tu l'as dit.

## 3. Agents (Settings › Agents)

- **Doorbell › Test** : envoie un ping signé à l'URL du webhook et dit en
  clair si ça marche.
- **Tokens** : pour chaque jeton, quand et **depuis quelle adresse** il a
  servi la dernière fois, et **Revoke** en un clic.
- **Quiet hours** : pas de sonnette ni de notification la nuit (sauf mail
  urgent « now ») ; le digest du matin dit combien de demandes attendent.

## 4. Petits plus

- Fichier trop gros : refusé **avant** l'envoi (Fichiers, pièces jointes).
- L'IA de démo répond dans ta langue.
- Widget « Important mail » rempli.
- Animations : passer d'une app à l'autre fait glisser la page ; dans
  Settings › Appearance, passer en sombre/clair fait **un cercle depuis ton
  clic** ; les boutons font une onde. *Calm* coupe tout.

## 5. Sécurité (ce qui a été corrigé)

- Une note piégée pouvait exécuter du code dans l'aperçu (faille XSS) :
  corrigé, avec des tests.
- Le collage HTML dans un mail est mieux nettoyé.
- Le serveur ne donne plus les sources ni les rapports internes.
- En-têtes de sécurité en plus ; outils de test mis à jour (plus aucune
  vulnérabilité connue).

## Ce que tu peux faire ensuite

- Mettre la v4 dans main :
  `cd ~/Documents/mailorganiser/atrium && git merge --ff-only night/v4`
- Détail technique : `reports/V4.md` (dans la branche `night/v4`).
- À lancer une fois (bloqué ici) :
  `cd services/gmessages && go run golang.org/x/vuln/cmd/govulncheck@v1.1.4 ./...`
