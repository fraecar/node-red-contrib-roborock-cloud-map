# node-red-contrib-roborock-cloud-map

[Français](README.fr.md) · English

> **Unofficial project.** This package is **not affiliated with, endorsed by, or connected to Roborock** in any way.
> It was **written with [Claude](https://claude.ai)**, an AI assistant made by Anthropic.
> It uses Roborock's unofficial cloud interface, which can change or stop working at any time. Use it at your own risk.

An add-on for [`node-red-contrib-roborock-local`](https://flows.nodered.org/node/node-red-contrib-roborock-local).
It adds a **map image** node (`roborock-map-image`) to the **Roborock** category of the palette. The node draws the
vacuum's map as a PNG, with the robot's position, its path, the dock, no-go zones and virtual walls.

- **Nothing to enter twice**: the node uses the *roborock device* node (DUID, local key) and the *roborock account*
  node (saved login) you already have.
- **No npm dependencies.**
- The map goes through the **Roborock cloud** (MQTT), like the Home Assistant integration. Local control is not used.
- Works with devices that use the cloud protocol `1.0` (S series, Qrevo, Saros...).

## Installation

The base package `node-red-contrib-roborock-local` must already be installed and your account signed in.

```bash
cd ~/.node-red
npm install /path/to/node-red-contrib-roborock-cloud-map-0.2.0.tgz
# then restart Node-RED
```

The node appears in the palette, category **Roborock**, as *map image*.

## Usage

Drop the node into a flow, pick your **device** (the same one the other roborock nodes use), and send it a message.
A sample flow is in `examples/map-image-flow.json` (a trigger every 5 minutes, plus the image served at `/roborock-map.png`).

### Outputs

| Property | Content |
| --- | --- |
| `msg.payload` | the PNG image: a buffer, base64 text, or a `data:image/png;base64,...` URL (node setting) |
| `msg.map` | `robot` (position in mm and in image pixels, heading, and the room it is in as `room.id` / `room.name`), `charger`, `rooms` (id, name, centre in pixels), `image` (width, height, scale), `zones`, `pathPoints`, `hiddenRooms`, `warnings`, `status`, `fetchedAt` |
| `msg.status` | robot status (`state`, `battery`, `clean_area`...) plus `stateText` and `cleanAreaM2` |
| `msg.device` | name, DUID, model, IP |

Optional inputs (also read from `msg.payload`; they override the node settings):
`msg.scale` (zoom from 1 to 10), `msg.hideRooms` (rooms to hide), `msg.hideUnnamed` (boolean).

### Hiding rooms

Useful when rooms you deleted in the Roborock app still show up on the map. Two settings on the node:

- **Hide rooms**: names or numbers separated by commas, for example `Garage, 18`. Names ignore case and accents.
- **Hide unnamed rooms**: hides every room that has no name in the Roborock app.

A hidden room is drawn as plain floor and left out of `msg.map.rooms`, and the robot is no longer reported inside it.
`msg.map.hiddenRooms` lists what was hidden and why (`name`, `id` or `unnamed`).
If no room on the map has a name (names unavailable), *hide unnamed rooms* is skipped and a warning is logged,
so the map is never blanked by mistake.

### In a dashboard

Set the output to **data URL** and use a `ui-template`:

```html
<template><img :src="msg.payload" style="max-width:100%"></template>
```

## Limits

- Do not trigger it more than about **once a minute**. Requests are queued: one runs, one waits, the rest are ignored.
- **Room names** appear when the rooms are named in the Roborock app and the base package is installed. Otherwise you only get room numbers.
- Room names are not drawn on the image (no embedded font); `msg.map.rooms` gives their positions.
- Tested with automated tests (a simulated Node-RED and a simulated MQTT broker), not on every robot model.
  Reports from real hardware are welcome in the issues.

## Credits and license

MIT license. The cloud protocol and the map format are ports of
[python-roborock](https://github.com/Python-roborock/python-roborock) and
[vacuum-map-parser-roborock](https://github.com/PiotrMachowski/Python-package-vacuum-map-parser-roborock) (Apache-2.0),
through the JavaScript port in the [saugi](https://github.com/michaelkrisper/saugi) project (MIT).

Written with [Claude](https://claude.ai) (Anthropic). Not affiliated with Roborock.

## Changelog

- **0.2.0**: hide rooms by name, by number, or "unnamed".
- **0.1.0**: first release.
