<p align="center"><img src="media/logo.svg" alt="SDK Overflow" width="112" height="112"></p>

# SDK Overflow

Extension Cursor (compatible VS Code) qui ajoute un agent de code basé sur le Claude Agent SDK. Elle utilise une clé API de la Claude Console : l'usage est facturé sur ton compte Console (ou sur un crédit Agent SDK si ton organisation en a un), pas sur un abonnement claude.ai.

L'idée : retrouver une expérience proche de Claude Code dans l'éditeur (fil d'outils, diffs, autorisations, sous-agents), en s'appuyant sur ta clé API. C'est utile pour continuer à travailler quand le quota de ton abonnement est épuisé, ou pour consommer un crédit Agent SDK.

L'icône « SDK Overflow » ouvre la liste des sessions du dossier. Une session s'affiche comme un onglet d'éditeur. La rouvrir reprend l'historique ; le premier message relance l'agent sur ce fil.

## Ce qu'elle fait

- Agent complet avec les outils de Claude Code : lecture, édition et création de fichiers, recherche dans le code, commandes shell, recherche web, questions, tâches.
- Le fil suit la présentation de Claude Code : une puce par étape (verte si l'outil a réussi, rouge s'il a échoué, clignotante s'il tourne). La réflexion s'affiche en « ∴ Réflexion… » pendant le travail, puis reste repliée avec sa durée ; un clic la déplie.
- Chaque outil a son rendu :
  - commande shell en grille IN / OUT, avec le code de sortie ;
  - modification en diff numéroté, avec « Ouvrir le diff » (le diff natif de l'éditeur, avant ↔ maintenant) ;
  - Read, Grep et Glob sur une ligne, dépliables ;
  - liste de tâches ;
  - sous-agent avec son propre fil imbriqué.
- Les sorties longues sont tronquées, avec « Afficher plus ». Les chemins s'ouvrent dans l'éditeur, les liens `https` dans le navigateur.
- Au-dessus de la saisie :
  - le bandeau des fichiers modifiés pendant la session (+/−, diff, ouverture) ;
  - la tâche en cours ;
  - un indicateur d'activité (« Exécution de… », « Réflexion… », chronomètre du tour).
- Réponses et blocs de code ont un bouton « Copier ». Le Markdown gère titres, listes, tableaux et citations.
- Les demandes d'accord (commande, modification, question, sortie du mode plan) s'affichent dans une feuille du panneau, au-dessus de la saisie, avec des choix numérotés (touches 1, 2, 3 ; Échap refuse). Ce n'est pas la boîte de dialogue de Cursor. Pour une question, il faut choisir une option : autoriser la feuille sans réponse ne suffit pas.
- Saisie : `/` ouvre les commandes (`/compact` résume le contexte, `/clear` le vide, `/cost`, `/help`…). `@` propose un fichier du projet. Entrée envoie, Maj+Entrée fait un saut de ligne. On peut envoyer le message suivant pendant que l'agent travaille.
- Images : colle une capture (Ctrl+V), glisse un fichier, ou ouvre « + » puis « Importer une image ».
- Glisser un fichier non image depuis l'explorateur insère `@chemin` dans le prompt.
- Sélection de code : clic droit > « SDK Overflow : envoyer la sélection », ou Ctrl+Alt+A (Cmd+Alt+A sur Mac).
- La barre latérale ne contient que les sessions. « Nouvelle session » ouvre un onglet. Un second clic sur « × » supprime la session du disque et ferme son onglet.
- Le modèle, l'effort et le mode (Manuel, Éditer automatiquement, Plan, Auto) sont dans la saisie, comme dans Claude Code. Maj+Tab change de mode. Échap interrompt l'agent. ↑ dans une saisie vide rappelle le dernier message.
- En-tête : « + » ouvre une nouvelle session, l'horloge liste les sessions, « ⋯ » regroupe la clé API, le compteur de dépense, /clear et /compact.
- Un sous-agent lancé avec l'outil Agent s'affiche dans la conversation, avec son propre fil. Les agents définis dans `~/.claude` et dans le projet sont chargés.
- Modes, depuis la pastille à droite de la saisie :
  - **Manuel** : feuille avant une commande et avant une modification.
  - **Éditer automatiquement** : les fichiers passent, les commandes demandent encore.
  - **Plan** : l'agent explore et propose, sans modifier.
  - **Auto** : ce qui passe un contrôle est autorisé, le reste s'arrête.
- Le `CLAUDE.md` du projet est chargé s'il existe.
- Coût de chaque tour sous la réponse, dépense cumulée dans l'en-tête, anneau de contexte à côté du modèle. `/compact` sert quand l'anneau se remplit.

## Construire et installer (une seule fois)

Le SDK embarque un binaire natif propre à chaque système : il faut donc construire l'extension **sur ta machine**.

Prérequis : Node.js 18 ou plus récent.

```bash
cd sdk-overflow
npm install
npm run package
```

Cela produit `sdk-overflow-0.1.4.vsix`. Dans Cursor :

1. Ouvre la palette de commandes (Ctrl+Shift+P, ou Cmd+Shift+P sur Mac).
2. Lance « Extensions: Install from VSIX… » et choisis le fichier `.vsix`.
3. Recharge la fenêtre si Cursor le propose.

L'icône « SDK Overflow » apparaît dans la barre d'activité.

## Clé API

1. Sur platform.claude.com, place-toi dans l'organisation à facturer (celle qui porte ton crédit, le cas échéant).
2. Crée une clé API.
3. Dans l'onglet de la session, clique sur « Ajouter la clé API » (écran d'accueil) ou passe par « ⋯ » > « Changer la clé API… », puis colle-la dans la boîte de saisie de l'éditeur. Elle est stockée dans le coffre sécurisé de l'éditeur, jamais dans un fichier.

## Réglages

| Réglage | Défaut | Rôle |
|---|---|---|
| `agentDev.model` | `sonnet` | Modèle au démarrage d'une session |
| `agentDev.maxUsd` | `50` | Plafond de dépense cumulée suivie par l'extension |
| `agentDev.confirmShell` | `true` | Feuille d'autorisation avant chaque commande shell. Les modifications dépendent du mode (Manuel, Éditer automatiquement, Plan, Auto). |
| `agentDev.claudePath` | vide | Binaire `claude` externe, seulement si le binaire embarqué est introuvable |

« ⋯ » > « Remettre le compteur à zéro » réinitialise la dépense. Ce compteur est une estimation locale : la page Facturation de la Console fait foi.

## Bonnes pratiques pour le budget

- « ⋯ » > « Vider le contexte », ou la commande `/clear`, vide le contexte sans relancer l'agent. Un contexte qui s'allonge coûte de plus en plus cher à chaque étape. Une nouvelle session est un autre onglet.
- `/compact` résume l'historique quand la jauge de contexte monte. C'est un appel de modèle : moins cher que de continuer avec un long fil, pas gratuit.
- Reste sur Sonnet pour le travail courant, passe sur Opus pour les problèmes difficiles.
- Si tu utilises un crédit promotionnel, note sa date d'expiration dans la Console.

## Vérification au premier usage

Après ton premier prompt, ouvre Facturation sur la Console : vérifie que la dépense est bien imputée là où tu l'attends (crédit ou solde). Si tu es aussi connecté à Claude Code avec ton compte claude.ai sur cette machine, l'extension force malgré tout l'usage de la clé API.

## Licence

MIT. Voir [LICENSE](LICENSE).

## Développement

```bash
npm install
npm run watch      # recompile à chaque modification
```

Puis F5 dans Cursor ou VS Code ouvert sur ce dossier pour lancer une fenêtre de test.
