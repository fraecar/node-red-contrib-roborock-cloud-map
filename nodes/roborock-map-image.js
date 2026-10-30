"use strict";

const path = require("node:path");
const cloudMap = require("../lib/cloud-map");

const OUTPUTS = new Set(["buffer", "base64", "dataurl"]);
const ROOMS_TTL_MS = 30 * 60 * 1000; // the cloud room list rarely changes; do not hit the REST API on every map

let roomsLoaderOverride = null;

module.exports = function (RED) {
    function RoborockMapImageNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const device = RED.nodes.getNode(config.device);
        const output = OUTPUTS.has(config.output) ? config.output : "buffer";
        const defaultScale = clampScale(config.scale, 3);
        const drawPath = config.drawPath !== false;

        const robots = new Set();
        let pending = 0;
        let chain = Promise.resolve();
        let roomsCache = null;
        let closed = false;
        let warnedNames = false;

        if (!device) {
            node.status({ fill: "red", shape: "ring", text: "select a device" });
        } else {
            node.status({});
        }

        async function cloudRooms() {
            if (roomsCache && Date.now() - roomsCache.at < ROOMS_TTL_MS) {
                return roomsCache.rooms;
            }
            let rooms = [];
            try {
                rooms = await loadRooms(RED, device.account);
            } catch (err) {
                node.debug(`Room names unavailable: ${err.message}`);
            }
            if (rooms.length) {
                roomsCache = { at: Date.now(), rooms };
            }
            return rooms;
        }

        async function handle(msg) {
            const creds = credentialsFor(RED, device);
            const body = msg.payload && typeof msg.payload === "object" && !Buffer.isBuffer(msg.payload) && !Array.isArray(msg.payload)
                ? msg.payload
                : {};
            const scale = clampScale(firstSet(msg.scale, body.scale, defaultScale), defaultScale);
            const hide = firstSet(msg.hideRooms, body.hideRooms, config.hideRooms);
            const hideUnnamed = firstSet(msg.hideUnnamed, body.hideUnnamed, config.hideUnnamed === true) === true;

            node.status({ fill: "yellow", shape: "ring", text: "requesting map" });
            const { status, rawMap, mapping } = await cloudMap.collect(creds.rriot, creds.device, {
                log: (line) => node.debug(line),
                onRobot: (robot) => robots.add(robot),
            });
            const names = cloudMap.namesFromMapping(mapping, await cloudRooms());
            const { report, png } = cloudMap.buildReport(rawMap, {
                device: creds.device,
                status,
                names,
                scale,
                drawPath,
                hide,
                hideUnnamed,
            });
            if (report.warnings.length && !warnedNames) {
                warnedNames = true; // once per deploy: a map is requested every few minutes
                node.warn(report.warnings.join("; "));
            }

            const out = msg && typeof msg === "object" ? RED.util.cloneMessage(msg) : {};
            out.payload = formatImage(png, output);
            out.map = report;
            out.status = report.status;
            out.command = "map_image";
            out.device = deviceSummary(device);

            node.status({
                fill: report.status && report.status.state === 12 ? "red" : "green",
                shape: "dot",
                text: statusText(report),
            });
            return out;
        }

        node.on("input", (msg, send, done) => {
            const emit = send || ((out) => node.send(out));
            const complete = done || ((err) => {
                if (err) {
                    node.error(err, msg);
                }
            });
            // One request running and one waiting is plenty: a map takes a few seconds,
            // and piling up requests would only hammer the cloud.
            if (pending >= 2) {
                node.warn("A map request is already running; message ignored");
                complete();
                return;
            }
            pending += 1;
            chain = chain
                .then(() => (closed ? null : handle(msg)))
                .then((out) => {
                    if (out) {
                        emit(out);
                    }
                    complete();
                })
                .catch((err) => {
                    if (closed) {
                        // Redeploy or shutdown while a request was running: not an error worth reporting.
                        complete();
                        return;
                    }
                    node.status({ fill: "red", shape: "ring", text: trim(err && err.message) });
                    complete(err);
                })
                .then(() => {
                    pending -= 1;
                });
        });

        node.on("close", (removed, done) => {
            const finish = typeof removed === "function" ? removed : done;
            closed = true;
            for (const robot of robots) {
                robot.close();
            }
            robots.clear();
            finish();
        });
    }

    RED.nodes.registerType("roborock-map-image", RoborockMapImageNode);
};

module.exports.setRoomsLoaderForTests = function (fn) {
    roomsLoaderOverride = fn;
};

/**
 * The MQTT credentials (rriot) come from the roborock-account node saved login, and the
 * duid / local key from the roborock-device node, so nothing has to be entered twice.
 */
function credentialsFor(RED, device) {
    if (!device) {
        throw new Error("No roborock device is selected on this node");
    }
    if (!device.duid) {
        throw new Error("The roborock device has no DUID. Use Fetch devices from account on the device node, then deploy");
    }
    if (!device.localKey) {
        throw new Error("The roborock device has no local key. Use Fetch devices from account on the device node, then deploy");
    }
    if (device.pv && device.pv !== "1.0") {
        throw new Error(`This device uses the ${device.pv} protocol, which this node does not support (only 1.0)`);
    }
    const account = device.account ? RED.nodes.getNode(device.account) : null;
    if (!account) {
        throw new Error("The roborock device is not linked to a roborock account node. Select the account on the device node");
    }
    let userData = account.credentials && account.credentials.userData;
    if (typeof userData === "string" && userData) {
        try {
            userData = JSON.parse(userData);
        } catch (_err) {
            userData = null;
        }
    }
    if (!userData || typeof userData !== "object") {
        throw new Error("The roborock account has no saved login. Sign in on the account node and deploy");
    }
    const rriot = userData.rriot;
    if (!rriot || !rriot.u || !rriot.s || !rriot.k || !rriot.r || !rriot.r.m) {
        throw new Error("The saved login has no MQTT credentials (rriot.k / rriot.r.m). Sign in again on the account node");
    }
    return {
        rriot,
        device: {
            duid: device.duid,
            localKey: device.localKey,
            model: device.model || "",
            name: device.deviceName || "",
        },
    };
}

/** Rooms of the account home: [{id, name}]. Uses the sibling package when it is there. */
async function loadRooms(RED, accountId) {
    if (roomsLoaderOverride) {
        return roomsLoaderOverride(accountId);
    }
    if (!accountId) {
        return [];
    }
    // The base package already knows how to read the cloud home data. Optional: without it
    // the map still works, only the room names are missing.
    const admin = requireBasePackage("lib/admin", RED);
    const rooms = await admin.loadCloudRooms(RED, accountId);
    return Array.isArray(rooms) ? rooms : [];
}

/**
 * Finds the base package next to this one. When this package was installed from a local
 * folder, npm makes a symlink and a plain require() looks in the wrong node_modules, so
 * fall back to resolving from the Node-RED user directory.
 */
function requireBasePackage(file, RED) {
    const id = `node-red-contrib-roborock-local/${file}`;
    try {
        return require(id);
    } catch (firstErr) {
        const userDir = RED && RED.settings && RED.settings.userDir;
        if (!userDir) {
            throw firstErr;
        }
        return require(require.resolve(id, { paths: [userDir, path.join(userDir, "node_modules")] }));
    }
}

function formatImage(png, output) {
    if (output === "base64") {
        return png.toString("base64");
    }
    if (output === "dataurl") {
        return `data:image/png;base64,${png.toString("base64")}`;
    }
    return png;
}

function statusText(report) {
    const parts = [];
    if (report.status) {
        parts.push(report.status.stateText);
    }
    if (report.robot && report.robot.room) {
        parts.push(report.robot.room.name || `room ${report.robot.room.id}`);
    }
    return trim(parts.join(" · ") || "map ready");
}

function deviceSummary(device) {
    if (!device) {
        return null;
    }
    return {
        name: device.deviceName || device.name || "",
        duid: device.duid || "",
        model: device.model || "",
        ip: device.ip || "",
    };
}

function clampScale(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 1 && n <= 10 ? Math.round(n) : fallback;
}

function trim(text) {
    const value = String(text || "");
    return value.length > 48 ? `${value.slice(0, 45)}...` : value;
}

function firstSet(...values) {
    return values.find((value) => value !== undefined && value !== null && value !== "");
}
