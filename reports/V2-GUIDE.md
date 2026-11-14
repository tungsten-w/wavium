# Wavium v2 « Bob » : guide de test

Version 2 de Wavium (ex-Atrium). La v1 s'appelait « Alice », la v2 « Bob ».
Instance de démo avec des **données fictives** : faux serveur mail, et une
**IA de démo** qui répond avec des règles sur des mots-clés, sans vrai
modèle ni clé. Rien ne sort de la machine.

## Ouvrir la démo

Elle tourne sur gallium, port **8300**. Depuis ton ordinateur :

```
ssh -L 8300:localhost:8300 sodium@gallium
```

Puis **http://localhost:8300** dans le navigateur.

| Compte | Mot de passe |
| --- | --- |
| `alice` | `alice-demo-pass` (l'utilisatrice principale) |
| `bob` | `bob-demo-pass` |
| `admin` | `admin-demo-pass` |

Relancer ou remettre la démo en place :

```
cd ~/Documents/mailorganiser/wt/v2
sg docker -c "ATRIUM_PORT=8300 COMPOSE_PROJECT_NAME=atrium-v2 bash deploy/dev/demo.sh"
```

## Nouveau dans la v2

| | |
| --- | --- |
| **Nom et logo** | Wavium partout : page de connexion (grande icône vague), en-tête, onglet du navigateur. |
| **Mail** | Tags colorés, rédaction avec mise en forme (gras, listes, liens). |
| **Agenda** | Invités et réponses aux invitations, abonnements à des agendas, pages de prise de rendez-vous, anciens liens d'événements. |
| **Tâches** | Tâches qui se répètent, ordre à la main (glisser-déposer), partage d'une liste. |
| **Installer chez soi** | `deploy/wavium/` : installation complète avec HTTPS automatique (Caddy), testée sur cette machine. |
| **Corrections** | Le résumé du jour ne montre plus les séparateurs « --- » de Daily Todo. |

## À tester (en alice)

Coche ce qui marche ; note le reste dans `reports/V2-RETOURS.md`.

### Nouveautés v2

- [ ] La page de connexion : logo, nom, slogan.
- [ ] **Mail** : ouvre un mail → ⋮ > **Tags…** → coche un tag, crée-en un ; il
      apparaît en couleur dans la liste.
- [ ] **Mail** : Nouveau message → **Formatting** → gras, liste, lien → envoie
      à bob ; connecte-toi en bob et regarde le message.
- [ ] **Agenda** : crée un événement avec bob comme invité ; en bob, réponds à
      l'invitation (Accepter / Peut-être / Refuser).
- [ ] **Agenda** : « Appointments » → crée une page de rendez-vous et copie
      son lien.
- [ ] **Tâches** : une tâche « Repeat: every week » avec une date → coche-la →
      elle passe à la semaine suivante.
- [ ] **Tâches** : réordonne en glissant ; menu de la liste > **Share** avec bob.

### Toujours là depuis la v1

- [ ] **Dashboard** : la carte **Today** (mails à traiter, rendez-vous, liste du
      jour, phrase de l'IA).
- [ ] **Mail** : tri automatique (puces, « Suspicious » sur l'arnaque),
      **Suggest a reply**, ⋮ > **Find dates…**, ⋮ > **Snooze…**, **Undo** après
      une suppression, autocomplétion dans **To**, la conversation sous un
      mail, la page **Rules**, le bandeau **Unsubscribe…** des newsletters.
- [ ] **Settings** : Agents, Agent activity, AI providers.
- [ ] **Assistant** (bouton robot) : tape
      `mock-tool: notes_note_create {"content":"Bonjour"}` → une note est créée.
- [ ] En **bob** : il ne voit rien d'alice (mails, règles, résumé).

## Installer Wavium sur un vrai serveur

Voir `deploy/wavium/README.md` : construire l'image, remplir `.env` (domaine,
mots de passe), `docker compose up -d`. HTTPS automatique avec Let's Encrypt.
Ensuite Settings > AI pour brancher une vraie IA.

## Limites connues

- L'IA de démo est fictive : réponses simples, en partie en anglais.
- Pas encore faits : filtres Sieve côté serveur, une sauvegarde dédiée à
  l'installation `deploy/wavium` (les commandes sont dans son README), les
  images publiées sur un registre (P6-2).
