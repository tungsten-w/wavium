# Atrium v1: guide de test

Instance de démo avec des **données fictives**. Le serveur mail est un faux
(GreenMail) et l'IA est une **IA de démo** : elle répond avec des règles sur
des mots-clés, sans vrai modèle et sans clé. Rien ne sort de la machine.

## Ouvrir la démo

Elle tourne sur gallium, port **8300**. Depuis ton ordinateur, ouvre un tunnel
SSH (remplace par ce que tu utilises d'habitude pour te connecter) :

```
ssh -L 8300:localhost:8300 sodium@gallium
```

Puis ouvre **http://localhost:8300** dans le navigateur.

| Compte | Mot de passe | Pour quoi |
| --- | --- | --- |
| `alice` | `alice-demo-pass` | l'utilisatrice principale (mails, agenda, agent) |
| `bob` | `bob-demo-pass` | un 2e utilisateur (vérifier qu'il ne voit rien d'alice) |
| `admin` | `admin-demo-pass` | les réglages d'instance (IA de l'instance) |

Relancer ou remettre en place la démo (depuis le dossier de la branche) :

```
cd ~/Documents/mailorganiser/wt/v1
sg docker -c "ATRIUM_PORT=8300 COMPOSE_PROJECT_NAME=atrium-v1 bash deploy/dev/demo.sh"
```

## À tester (connecte-toi en alice)

Coche ce qui marche ; pour le reste, note ce qui gêne dans
`reports/V1-RETOURS.md`, même une ligne.

### 1. Dashboard : la carte « Today »

- [ ] En haut, la carte **Today** : mails qui attendent une réponse ou une action,
      l'événement du jour, la liste du jour (Daily Todo) et une phrase de l'IA.
- [ ] Un clic sur un mail l'ouvre dans Mail.
- [ ] La roue dentée : préparer le résumé chaque matin, l'heure, la notification,
      la phrase d'IA.

### 2. Mail : le tri automatique

- [ ] Dans la liste, des puces sur chaque mail (catégorie, « Needs reply »…).
- [ ] Le mail « URGENT : votre compte sera suspendu » est marqué **Suspicious**.
- [ ] Barre latérale > **Status** : l'état du tri, le modèle (« IA de démo · demo »).

### 3. Mail : répondre avec l'IA

- [ ] Ouvre « Dîner samedi ? » (de Bob) → bouton **Suggest a reply** → la fenêtre
      de rédaction s'ouvre avec un brouillon. **Rien n'est envoyé** sans ton clic.

### 4. Mail : les dates dans un mail

- [ ] Ouvre « Réunion projet jeudi 14h » → menu **⋮** > **Find dates…** → un
      événement est proposé. **Add to calendar** → il apparaît dans Agenda.
- [ ] Ouvre « Votre facture de novembre » → **Find dates…** → une tâche « Payer la
      facture ».

### 5. Mail : règles de rangement

- [ ] Barre latérale > **Rules** → écris par exemple « les factures de
      energie.example.com dans Archive, marquées lues » → **Propose** → la règle
      et le nombre de mails concernés. Rien n'est fait avant **Save**.
- [ ] **Save and file these 1 now** → la facture passe dans Archive.

### 6. Mail : newsletters, suppression, rappel

- [ ] Ouvre « Cette semaine : 10 astuces Git » → bandeau **Unsubscribe…** →
      une confirmation explique ce qui va se passer. (Ne confirme pas : le lien
      de la démo pointe vers un domaine qui n'existe pas.)
- [ ] Supprime un mail → la bulle propose **Undo** → il revient.
- [ ] Menu **⋮** > **Snooze…** → choisis un moment → le mail quitte la boîte
      (il reviendra à l'heure choisie).
- [ ] Nouveau message → tape « bo » dans **To** → Bob est proposé.
- [ ] Sous un mail qui fait partie d'une conversation : les autres messages.

### 7. Agents (ce qui sert à connecter Claude, Codex…)

- [ ] **Settings > Agents** : l'agent « Mon assistant » avec ses droits par app
      (lire / écrire / envoyer / supprimer, avec ou sans ton accord).
- [ ] **Settings > Agent activity** : ce que les agents ont fait, les demandes
      d'accord (Approve / Reject).
- [ ] **Settings > AI** : les fournisseurs d'IA. L'« IA de démo » est celle de
      l'instance ; un vrai fournisseur (Anthropic, OpenAI, Mistral, Ollama) se met
      ici avec une clé.

### 8. Assistant intégré (bouton robot en haut)

- [ ] Le panneau s'ouvre. L'IA de démo ne fait que répéter tes messages ; pour
      voir un outil marcher, tape exactement :
      `mock-tool: notes_note_create {"content":"Bonjour"}` → une note est créée.

### 9. Le reste d'Atrium

- [ ] Agenda, Contacts, Fichiers, Notes, Daily Todo : ouvrir, créer, modifier.
- [ ] Connecte-toi en **bob** : il ne voit ni les mails ni les règles d'alice.

## Ce qui est volontairement limité dans la démo

- L'IA est fictive : ses réponses sont simples et en partie en anglais
  (« 1 mail needs a reply… »). Avec une vraie IA, tout est dans ta langue.
- Pas de vrais mails : envoyer un mail l'envoie au faux serveur, seulement entre
  alice et bob.
- Pas encore faits : tags, rédaction en HTML, filtres Sieve (P4-1b) ; le reste de
  la liste dans `TASKS.md`.
