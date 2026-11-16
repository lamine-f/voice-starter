# voice-starter

Briques pour ajouter une interface vocale à n'importe quelle application : un
cœur vocal sans interface, un protocole de messages JSON, des ports pour
l'audio et le fournisseur de voix, et un relais qui garde la clé du
fournisseur côté serveur.

JARVIS Local est le premier client de ce starter.

## Paquets

| Paquet                              | Où il tourne                                  | Rôle                                                                                  |
| ----------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------- |
| `@lamine-f/voice-protocol`          | partout                                       | Commandes, événements, états, déclarations d'outils, `SessionGrant`                   |
| `@lamine-f/voice-core`              | client                                        | La session : machine à états, reconnexion, historique, routage des outils, injections |
| `@lamine-f/voice-audio-web`         | navigateur                                    | Micro → PCM16 (AudioWorklet) et lecture enchaînée                                     |
| `@lamine-f/voice-provider-deepgram` | `/client` : navigateur · `/server` : serveur  | Adaptateur Deepgram Voice Agent, réglages de session et jetons temporaires            |
| `@lamine-f/voice-broker`            | `.` : serveur · `/client`, `/tools` : partout | Registre d'outils (Zod), relais, routes Hono, client HTTP                             |

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
  `@lamine-f/voice-broker/tools` donne les déclarations sans le relais (ni
  Hono ni code serveur), pour un fichier partagé avec la page.
- Les arguments envoyés par l'agent sont vérifiés avant tout gestionnaire :
  par le relais pour un outil serveur, par le cœur pour un outil client,
  contre le JSON Schema publié et sans bibliothèque dans la page. Les
  schémas s'écrivent donc dans le sous-ensemble que le cœur vérifie
  (`SCHEMA_KEYWORDS` du protocole) : le relais refuse le reste dès la
  déclaration, unions comprises.
- `ToolResult<typeof outil>` donne le type de ce que renvoie un outil
  serveur : la page le reçoit dans l'événement `toolActivity`.
- Une erreur interne d'un outil (base, service) ne sort pas du relais : le
  client reçoit « erreur interne du relais », le détail va dans la console du
  serveur. Seule une `BrokerError` porte son message jusqu'à l'agent.

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

## Réglages Deepgram

`deepgramConfigFromEnv(process.env)` lit :

| Variable | Défaut | Rôle |
|---|---|---|
| `DEEPGRAM_API_KEY` | *(requis)* | Clé du serveur, jamais envoyée au navigateur |
| `DEEPGRAM_LISTEN_MODEL` | `nova-3` | Transcription. `flux-general-multi` entendait de l'anglais sur des phrases françaises courtes ; Flux n'a pas de modèle français |
| `DEEPGRAM_LANGUAGE_HINTS` | `fr` | Langue d'écoute (la première ; `flux-general-multi` les prend toutes comme indices) |
| `DEEPGRAM_KEYTERMS` | *(aucun)* | Mots rares à reconnaître : noms de produits, jargon |
| `DEEPGRAM_THINK_PROVIDER` / `_MODEL` / `_VERSION` | `open_ai` / `gpt-5.4-mini` | Modèle de dialogue, hébergé et facturé par Deepgram : aucune autre clé |
| `DEEPGRAM_SPEAK_MODEL` | `flux-thierry-fr` | Voix |

Un réglage refusé par Deepgram (modèle inconnu…) arrête la session avec une
erreur fatale `provider` (« réglages refusés · … ») : se reconnecter
renverrait les mêmes réglages.

## Installer dans un autre projet

Les paquets sont publics sur npm :

```
pnpm add @lamine-f/voice-core @lamine-f/voice-audio-web @lamine-f/voice-broker @lamine-f/voice-provider-deepgram
```

Le relais ne tient aucune connexion ouverte : le navigateur parle directement
au fournisseur avec un jeton temporaire, le serveur ne répond qu'à deux appels
HTTP courts. Il tourne donc aussi sur des fonctions sans état (Vercel,
Cloudflare) : `brokerRoutes(...).fetch` se branche dans un route handler.
`authorize` y protège les deux routes, l'ouverture de session comprise.

## Publier

Connecté au compte npm `lamine-f` (`npm login`), après avoir monté les
versions : `pnpm build`, puis `pnpm -r publish`. pnpm remplace les
dépendances `workspace:*` par leur version.

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
