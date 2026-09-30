# SCI RUVELON GESTION 3 - Supabase

Nouvelle version separee de l'application Google Apps Script.

Objectif: avoir un outil simple, rapide et utilisable sur telephone pour suivre:

- les factures faites dans MEG;
- les loyers attendus et payes;
- les baux arrivant a echeance dans les 6 mois;
- les locaux et locataires;
- les travaux a suivre;
- la remuneration gerant.

L'ancienne version Apps Script n'est pas modifiee par cette V3.

## Contenu

- `web/` : application mobile web installable.
- `supabase/schema.sql` : structure complete de la base Supabase avec securite.
- `web/config.js` : configuration Supabase a renseigner.

## Mise en service rapide

1. Creer un projet Supabase.
2. Ouvrir SQL Editor dans Supabase.
3. Coller et executer le contenu de `supabase/schema.sql`.
4. Executer `supabase/verification.sql` pour controler les tables, les utilisateurs et la securite.
5. Dans Supabase Auth, creer les utilisateurs:
   - `bidal.michel2@gmail.com`
   - `matthieu.lonchamp@gmail.com`
6. Copier dans `web/config.js`:
   - l'URL du projet Supabase;
   - la cle publique `anon`.
7. Ouvrir `web/index.html` ou heberger le dossier `web/`.

## Droits prevus

- Michel Bidal: administrateur, creation et modification.
- Matthieu Lonchamp: lecture seule.

La securite est aussi appliquee cote Supabase avec les politiques RLS.
L'interface masque aussi les boutons d'ecriture pour l'utilisateur en lecture seule.

## Utilisation telephone

Depuis le navigateur du telephone:

- Android / Chrome: menu Chrome, puis ajouter a l'ecran d'accueil.
- iPhone / Safari: bouton Partager, puis Sur l'ecran d'accueil.

L'application garde une navigation basse, des boutons larges et un affichage pense pour le pointage rapide.

## Mode apercu local

Si Supabase n'est pas encore configure dans `web/config.js`, l'application propose un mode apercu local.

Ce mode sert seulement a tester l'ergonomie. Les donnees restent sur l'appareil et ne sont pas partagees.

## Prochaine etape conseillee

Importer les donnees reelles 2026 dans Supabase:

- locaux;
- locataires;
- baux;
- loyers deja suivis;
- remuneration gerant.

Ensuite, la V3 pourra remplacer progressivement le suivi Google Sheets.
