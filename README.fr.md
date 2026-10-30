# node-red-contrib-roborock-cloud-map

Français · [English](README.md)

> **Projet non officiel.** Ce paquet n'est **ni associé, ni approuvé, ni lié à Roborock**, de quelque manière que ce soit.
> Il a été **écrit avec [Claude](https://claude.ai)**, un assistant d'IA d'Anthropic.
> Il utilise l'interface cloud non officielle de Roborock, qui peut changer ou cesser de fonctionner à tout moment. À utiliser à vos risques.

Module complémentaire de [`node-red-contrib-roborock-local`](https://flows.nodered.org/node/node-red-contrib-roborock-local).
Il ajoute à la catégorie **Roborock** un nœud **image de la carte** (`roborock-map-image`) qui dessine la carte de
l'aspirateur en PNG, avec sa position, son trajet, la base, les zones interdites et les murs virtuels.

- **Rien à configurer en double** : le nœud utilise le nœud *roborock device* (DUID, clé locale) et le nœud
  *roborock account* (connexion déjà enregistrée) que vous avez déjà.
- **Aucune dépendance** npm.
- La carte passe par le **cloud Roborock** (MQTT), comme l'intégration Home Assistant. Le contrôle local n'est pas utilisé.
- Appareils au protocole cloud `1.0` (série S, Qrevo, Saros…).

## Installation

Le paquet de base `node-red-contrib-roborock-local` doit déjà être installé et votre compte connecté.

```bash
cd ~/.node-red
npm install /chemin/vers/node-red-contrib-roborock-cloud-map-0.2.0.tgz
# puis redémarrer Node-RED
```

Le nœud apparaît dans la palette, catégorie **Roborock**, sous le nom *map image*.

## Utilisation

Glissez le nœud, choisissez votre **appareil** (le même que pour les autres nœuds roborock), envoyez-lui un message.
Exemple de flow : `examples/map-image-flow.json` (déclenchement toutes les 5 minutes + image servie sur `/roborock-map.png`).

### Sorties

| Propriété | Contenu |
| --- | --- |
| `msg.payload` | l'image PNG : buffer, texte base64 ou URL `data:image/png;base64,…` (réglage du nœud) |
| `msg.map` | `robot` (position en mm et en pixels, cap, pièce `room.id` / `room.name`), `charger`, `rooms` (id, nom, centre en pixels), `image` (largeur, hauteur, échelle), `zones`, `pathPoints`, `hiddenRooms`, `warnings`, `status`, `fetchedAt` |
| `msg.status` | état du robot (`state`, `battery`, `clean_area`…) + `stateText`, `cleanAreaM2` |
| `msg.device` | nom, DUID, modèle, IP |

Entrées facultatives (aussi lues dans `msg.payload`, et elles remplacent les réglages du nœud) :
`msg.scale` (zoom de 1 à 10), `msg.hideRooms` (pièces à masquer), `msg.hideUnnamed` (booléen).

### Masquer des pièces

Utile quand des pièces supprimées dans l'appli Roborock apparaissent encore sur la carte. Deux réglages dans le nœud :

- **Masquer des pièces** : des noms ou des numéros séparés par des virgules, par exemple `Garage, 18`. Les noms ignorent
  la casse et les accents.
- **Masquer les sans-nom** : masque toutes les pièces qui n'ont pas de nom dans l'appli Roborock.

Une pièce masquée est dessinée comme du simple sol, absente de `msg.map.rooms`, et le robot n'est plus signalé dedans.
`msg.map.hiddenRooms` liste ce qui a été masqué et pourquoi (`name`, `id` ou `unnamed`).
Si aucune pièce de la carte n'a de nom (noms indisponibles), « masquer les sans-nom » est ignoré et un avertissement
est journalisé : la carte n'est jamais effacée par erreur.

### Dans un dashboard

Réglez la sortie sur **URL de données** et utilisez un `ui-template` :

```html
<template><img :src="msg.payload" style="max-width:100%"></template>
```

## Limites

- N'appelez pas plus d'**une fois par minute** environ. Les demandes sont mises en file : une s'exécute, une attend, les autres sont ignorées.
- Les **noms de pièces** apparaissent si les pièces sont nommées dans l'appli Roborock et si le paquet de base est présent. Sinon, seuls les numéros sont fournis.
- Les noms de pièces ne sont pas dessinés sur l'image (pas de police embarquée) ; `msg.map.rooms` donne leurs positions.
- Testé avec des tests automatisés (faux Node-RED et faux broker MQTT), pas sur tous les modèles de robot.
  Les retours sur matériel réel sont les bienvenus dans les issues.

## Crédits et licence

Licence MIT. Le protocole et le format de carte sont des portages de
[python-roborock](https://github.com/Python-roborock/python-roborock) et
[vacuum-map-parser-roborock](https://github.com/PiotrMachowski/Python-package-vacuum-map-parser-roborock) (Apache-2.0),
via le portage JavaScript du projet [saugi](https://github.com/michaelkrisper/saugi) (MIT).

Écrit avec [Claude](https://claude.ai) (Anthropic). Sans lien avec Roborock.

## Historique

- **0.2.0** : masquer des pièces par nom, par numéro ou « sans nom ».
- **0.1.0** : première version.
