# voice-starter

Briques pour ajouter une interface vocale à n'importe quelle application : un
cœur vocal sans interface, un protocole de messages JSON, des ports pour
l'audio et le fournisseur de voix, et un relais qui garde la clé du
fournisseur côté serveur.

JARVIS Local est le premier client de ce starter.

## Paquets

| Paquet                              | Où il tourne                                 | Rôle                                                                                  |
| ----------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------- |
| `@lamine-f/voice-protocol`          | partout                                      | Commandes, événements, états, déclarations d'outils, `SessionGrant`                   |
| `@lamine-f/voice-core`              | client                                       | La session : machine à états, reconnexion, historique, routage des outils, injections |
| `@lamine-f/voice-audio-web`         | navigateur                                   | Micro → PCM16 (AudioWorklet) et lecture enchaînée                                     |
| `@lamine-f/voice-provider-deepgram` | `/client` : navigateur · `/server` : serveur | Adaptateur Deepgram Voice Agent, réglages de session et jetons temporaires            |
| `@lamine-f/voice-broker`            | `.` : serveur · `/client` : navigateur       | Registre d'outils (Zod), relais, routes Hono, client HTTP                             |

## Principe

```
Interface ──commandes──▶ Cœur ──▶ AudioInput / AudioOutput
          ◀─événements──      ──▶ VoiceProvider ──WebSocket──▶ fournisseur
                              ──▶ SessionBroker ──HTTP──▶ relais (clé, prompt, outils)
```

- Le cœur ne connaît ni le DOM, ni le système, ni la clé du fournisseur.
- Commandes et événements sont du JSON pur : le même contrat sert dans la
  page, à travers une iframe (`postMessage`), un IPC ou une WebSocket. Aux
  frontières, `toWire` / `fromWire` ajoutent et vérifient la version.
- Chaque outil est déclaré **une fois**, avec son schéma Zod et l'endroit où
  il s'exécute (`client` : l'hôte, `server` : le relais). Utiliser le `z`
  exporté par `@lamine-f/voice-broker`, celui qui produit les JSON Schema.

## Exemple

**Serveur** (Node, Hono) :

```ts
import { brokerRoutes, createBroker, implement, tool, z } from "@lamine-f/voice-broker";
import { deepgramBackend, deepgramConfigFromEnv } from "@lamine-f/voice-provider-deepgram/server";
import { Hono } from "hono";

const showCard = tool({
  name: "show_card",
  description: "Affiche une carte.",
  runsOn: "client",
  parameters: z.object({ title: z.string(), content: z.string() }),
});
const getWeather = tool({
  name: "get_weather",
  description: "Météo d'une ville.",
  runsOn: "server",
  parameters: z.object({ city: z.string() }),
});

const broker = createBroker({
  provider: deepgramBackend(deepgramConfigFromEnv(process.env)),
  prompt: "Tu es un assistant vocal concis.",
  tools: [showCard, implement(getWeather, async ({ city }) => ({ city, temp: 21 }))],
});

const app = new Hono();
// Placer ici le contrôle d'accès de l'application (session, jeton…).
app.route("/voice", brokerRoutes(broker));
```

**Navigateur** :

```ts
import { WebAudioInput, WebAudioOutput } from "@lamine-f/voice-audio-web";
import { httpBroker } from "@lamine-f/voice-broker/client";
import { createVoiceSession } from "@lamine-f/voice-core";
import { deepgramProvider } from "@lamine-f/voice-provider-deepgram/client";

const session = createVoiceSession({
  broker: httpBroker("/voice"),
  provider: deepgramProvider(),
  audioIn: new WebAudioInput(),
  audioOut: new WebAudioOutput(),
});

session.subscribe((event) => {
  if (event.type === "toolCall" && event.name === "show_card") {
    // … afficher la carte, puis répondre :
    session.dispatch({ type: "toolResult", callId: event.callId, result: { status: "displayed" } });
  }
});

// Depuis un clic : le navigateur exige un geste avant de démarrer l'audio.
button.onclick = () => session.dispatch({ type: "start", clientTools: ["show_card"] });
```

Si le relais déclare un outil client que l'hôte n'a pas listé dans
`clientTools`, `start` échoue avec l'erreur `missing_tool_handlers`.

## Installer dans un autre projet

Les paquets sont publiés sur GitHub Packages, dont le registre demande un
jeton même pour lire (droit `read:packages`). Le `.npmrc` du projet, versionné,
ne dit que le registre :

```
@lamine-f:registry=https://npm.pkg.github.com
```

Le jeton n'y figure jamais : pnpm refuse un identifiant venu d'un fichier
versionné. Il va dans la configuration de l'utilisateur, en local
(`pnpm config set "//npm.pkg.github.com/:_authToken" <jeton>`) comme chez
l'hébergeur (sur Vercel, la variable `NPM_RC` reçoit ces deux lignes).
Ensuite : `pnpm add @lamine-f/voice-core @lamine-f/voice-audio-web
@lamine-f/voice-broker @lamine-f/voice-provider-deepgram`.

Le relais ne tient aucune connexion ouverte : le navigateur parle directement
au fournisseur avec un jeton temporaire, le serveur ne répond qu'à deux appels
HTTP courts. Il tourne donc aussi sur des fonctions sans état (Vercel,
Cloudflare) : `brokerRoutes(...).fetch` se branche dans un route handler.
`authorize` y protège les deux routes, l'ouverture de session comprise.

## Publier

Avec un jeton qui a le droit `write:packages` (`gh auth refresh -s
write:packages`), enregistré comme ci-dessus
(`pnpm config set "//npm.pkg.github.com/:_authToken" "$(gh auth token)"`) :
`pnpm build`, puis `pnpm -r publish`. pnpm remplace les dépendances
`workspace:*` par leur version.

## Développement

Node ≥ 22.18 et pnpm.

```
pnpm install
pnpm build       # dist/ de chaque paquet
pnpm test        # Vitest, sur les sources
pnpm typecheck   # paquets et tests
pnpm lint        # Biome
```

## Licence

MIT
