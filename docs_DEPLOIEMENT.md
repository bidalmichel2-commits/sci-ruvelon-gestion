# Deploiement Supabase - SCI RUVELON GESTION 3

## 1. Creer le projet Supabase

Aller sur Supabase, creer un nouveau projet, puis attendre la fin de l'initialisation.

Noter:

- `Project URL`
- `anon public key`

Ces deux valeurs seront a placer dans `web/config.js`.

## 2. Creer la base

Dans Supabase:

1. Ouvrir `SQL Editor`.
2. Creer une nouvelle requete.
3. Coller tout le contenu de `supabase/schema.sql`.
4. Executer.

Le script cree les tables, les vues, les fonctions, les droits et les utilisateurs autorises.

## 2 bis. Verifier la base

Dans `SQL Editor`, lancer ensuite le contenu de:

```text
supabase/verification.sql
```

Le resultat doit montrer:

- les tables creees;
- `bidal.michel2@gmail.com` en role `admin`;
- `matthieu.lonchamp@gmail.com` en role `lecture`;
- `rowsecurity = true` sur les tables principales.

## 3. Creer les comptes de connexion

Dans Supabase:

1. Ouvrir `Authentication`.
2. Creer un utilisateur pour `bidal.michel2@gmail.com`.
3. Creer un utilisateur pour `matthieu.lonchamp@gmail.com`.

Michel est administrateur dans la table `app_users`.
Matthieu est en lecture seule.

Dans l'application:

- Michel voit les boutons Ajouter / Modifier / Supprimer / Generer.
- Matthieu consulte seulement; les actions d'ecriture sont masquees et bloquees.

## 4. Configurer l'application

Dans `web/config.js`, renseigner:

```js
window.SCI_RUVELON_CONFIG = {
  supabaseUrl: "https://VOTRE-PROJET.supabase.co",
  supabaseAnonKey: "VOTRE_CLE_ANON_PUBLIC",
  appName: "SCI RUVELON GESTION 3",
  adminEmail: "bidal.michel2@gmail.com",
  readonlyEmail: "matthieu.lonchamp@gmail.com"
};
```

La cle `anon` est une cle publique prevue pour le navigateur.
Les vraies protections sont dans les politiques RLS Supabase.

## 5. Heberger l'application

Le dossier `web/` peut etre heberge sur:

- Netlify;
- Vercel;
- GitHub Pages;
- Cloudflare Pages;
- un petit serveur web local.

Supabase gere la base et l'authentification. Le dossier `web/` gere l'affichage.

## 6. Controle apres deploiement

Verifier:

- connexion Michel;
- connexion Matthieu;
- Matthieu ne peut pas modifier;
- creation d'un local;
- creation d'un locataire;
- creation d'un bail;
- generation du mois dans Pointage MEG;
- cases MEG et Paye;
- alerte bail a moins de 6 mois;
- saisie remuneration.

## Informations necessaires pour finaliser `web/config.js`

Une fois le projet Supabase cree, il faut renseigner:

- `Project URL`
- `anon public key`

Sans ces deux valeurs, l'application reste volontairement en `Mode apercu local`.
