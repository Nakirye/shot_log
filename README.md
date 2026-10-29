# Shot Log

Shot Log is an espresso journal: for every shot it records the bean, grind size, dose, yield, brew time and taste. This makes it easy to trace which settings make a bean or blend taste best. In addition, the espresso machine can be switched on and off via Home Assistant, also on a schedule.

The app was created as part of an exercise on **vibe coding**. The focus was not on a perfect end product, but on trying out vibe coding itself and documenting the experience.

- **Tool used:** Claude Code
- **Tech stack:** Frontend made of `index.html`, `styles.css` and `app.js` (vanilla JavaScript, no framework), installable as a PWA. A small Python server (standard library only) serves the app, syncs the data between devices and controls the machine.

## Features

- **Log shots:** bean, date, grind size, brew time, dose and yield (with automatically calculated brew ratio). Optionally also water temperature, pre-infusion and portafilter basket.
- **Rate the taste:** star rating, "Barista Compass" with dial-in tips, taste profile via sliders, flavor tags and notes.
- **Manage beans and recipes:** add beans, filter and sort shots by bean, save and reuse espresso recipes. Pour-over recipes (e.g. V60) are supported as well.
- **Sync between devices:** everything is stored locally first and then synced with the server. On conflicts, the most recent change wins per shot or bean.
- **Machine control (optional):** switch on and off immediately, one-time timer, weekly schedule (e.g. Mon–Fri at 06:30) and automatic power-off after 60 minutes.
- **Works offline and is installable** as an app on your phone (PWA).

## Installation & Startup

Requires Python 3.9 or newer. There are no other dependencies.

```sh
python3 server.py
```

The app is then available at `http://localhost:8000`. On first start, the server generates a **sync token**, prints it to the console and stores it in `data/token`. The data itself is stored in `data/shotlog.json`.

| Option / environment variable | Default |
|---|---|
| `--port`, `PORT` | `8000` |
| `--host` | `0.0.0.0` |
| `--data` | `./data` |
| `SHOTLOG_TOKEN` | Contents of `data/token`, generated on first start |
| `--ha-url`, `HA_URL` | – (machine control disabled) |
| `--ha-token`, `HA_TOKEN` | – |
| `--ha-entity`, `HA_ENTITY` | – |
| `--auto-off`, `AUTO_OFF_MINUTES` | `60` (`0` = never) |

### Sync between devices

1. In the app, open **Setup → Sync between devices**.
2. Paste the sync token and tap **Save & sync**. Leave the *Server URL* field empty if the app is opened directly from the server.
3. Repeat on every other device.

### Switching on the machine (Home Assistant)

The server switches a Home Assistant entity, e.g. the machine's smart plug. The machine's own power switch stays switched on.

1. In Home Assistant, create a token under *Profile → Security → Long-lived access tokens*.
2. Start the server like this:

   ```sh
   HA_URL=http://homeassistant.local:8123 \
   HA_TOKEN=<token> \
   HA_ENTITY=switch.espresso_machine \
   python3 server.py
   ```

Timers and the weekly schedule run **on the server**. They therefore also work when the phone is in standby or offline. Weekly times use the server's time zone. The Home Assistant token stays on the server and is never sent to the app.

### Installing as an app on your phone

Browsers only allow installing a PWA over **HTTPS** (exception: `localhost`). Via `http://192.168.x.x:8000` on your home network, the app can be used and synced, but not installed. You can get HTTPS, for example, like this:

- **Tailscale:** `tailscale serve --bg 8000`, then open `https://<machine>.<tailnet>.ts.net` on your phone.
- **Reverse proxy with your own domain**, e.g. Caddy: `shots.example.com { reverse_proxy localhost:8000 }`

After changes in `public/`, `CACHE` in `public/sw.js` must be incremented so that installed apps load the new version.

### Files

```
server.py                    Server: static files, sync API, machine control + schedule
public/index.html            User interface
public/app.js                App logic, offline storage, sync client
public/styles.css            Styles (light/dark)
public/sw.js                 Service worker (offline cache)
public/manifest.webmanifest  PWA manifest
public/icons/                App icons
```

---

## Experiences with Vibe Coding

### What worked well?

- **Scope after just one prompt:** It was impressive how extensive and detailed the result was after a single prompt. The AI made many assumptions, for example about which data I want to track for a shot. In this case, those assumptions mostly fit well.
- **The AI "thinks along":** It didn't just work through the given task, but also contributed its own ideas. Syncing between multiple devices, for example, was suggested by the AI itself; I then picked up the suggestion in prompt 2. It also pointed out problems with my server setup on its own and supplied suitable solutions right away. One example is the note that the app can only be installed as a PWA over HTTPS, along with suggested solutions using Tailscale or a reverse proxy.
- **Traceability:** The AI logs in great detail what it is currently doing. This makes it easy to follow which steps it takes.
- **Determination:** The AI carries out the task it is given consistently, come what may. However, this also has a downside (see below).

### What didn't work well?

- **Cluttered design:** After the first prompt, the interface was very cluttered and confusing, considering the use case (quickly logging recipes, the most important info at a glance).
- **No follow-up questions on big decisions:** The AI made far-reaching architectural decisions without asking a single question and simply took them as given.
- **Unnecessary features:** Besides useful parameters, things I don't need were also built in, for example a shot timer directly in the form.
- **Design changes are hard to convey:** Describing concrete design changes in words so that the AI implements them as intended was very tedious.
- **Domain logic errors:** Anyone familiar with the subject quickly spots logic errors. One example: the app classifies a shot via the "Barista Compass", i.e. by extraction (sour to bitter) and strength. Directly below, you rate the same shot again using separate sliders for acidity, sweetness and bitterness. This is redundant and can be contradictory. A second example is the generalization of a "correct" brew ratio (ratio of ground coffee to water in espresso) and extraction time. This makes no sense, because baristas know that, among other things, the grind size can have a very large influence on the brew ratio AND the extraction time needed to achieve a drinkable result. In addition, all of the app's recipe adjustment recommendations are based on deviations from these values generalized across all recipes.



### What problems did I identify?

- **Getting tangled up in its own tests:** The AI got tangled up in its self-written tests and "found" problems that weren't actually problems. This used up tokens unnecessarily, but had no negative impact on the end result.
- **Quality depends heavily on the prompt:** The more abstract the request and the less information you give the AI, the more freely it interprets the task, and the less usable the result becomes. At first glance it does look impressive. As soon as you look more closely, however, the house of cards collapses: you find logic errors and features or design decisions that make little sense from a domain perspective.
- **Expertise:** Without solid domain knowledge (expert knowledge), it is hard to judge the quality of the result. The AI cannot judge whether the end result is correct from a domain perspective and makes sense. It can only complete the given task; it does "think along", but by far does not have the solid domain knowledge of the subject that is crucial for a good, practical result.

### Expectation vs. reality

- **Architecture:** I had expected a large backend. The first run produced merely an `index.html` and an `app.js`. The Python server was only added with the second prompt, when it came to syncing between devices. Architecturally, this choice makes sense: the app works with or without a server and always stores the data locally. KISS - keep it simple, stupid.
- **Code consistency:** Here I was positively surprised. I had expected the code to become more inconsistent with every new request. In fact, it stayed consistent across all prompts and programming languages.
- **Follow-up questions:** I had expected the AI to ask follow-up questions on vague requests. Instead, the AI made assumptions on its own, no matter how vague the request was. The very first follow-up question only came with the prompt *"Add the ability to power on the espresso machine on a timer"*.

### What would have been better?

- **Fewer assumptions, more follow-up questions:** Especially for fundamental decisions such as architecture, data model or scope, it would make sense for the AI to ask first instead of simply assuming.
- **More interaction:** A more iterative process in which intermediate states are agreed upon would probably have led to a more suitable result.
- **Tests with real systems:** Instead of testing against mock systems, tests with the actual systems (e.g. my Home Assistant instance) would have been more meaningful.
- **Context:** For the result to be truly usable, the AI needs context information. The line between too much and too little context is thin. Too much context can unnecessarily increase token usage; too little context leads to assumptions that are not usable.

### Conclusion

Vibe coding is very well suited for quickly getting an impressive first prototype. The code produced is technically correct. Automated tests help to get a working end result. For a truly usable result, however, you need precise prompts, your own domain knowledge for verification and the willingness to critically question the AI's assumptions. The question "how much context does the AI need?" largely determines the end result.

---

## Prompts used

All prompts in chronological order, unchanged, exactly as I entered them in Claude Code.

### Prompt 1

```
create an app for documenting espresso shots. I use a espresso machine with a separate grinder. I want to keep track of the settings I use for my shots, the type of coffee beans I use and the taste profile.
```

### Prompt 2

```
syncing it on multiple devices sounds like a good feature. make it also installable as a PWA on my phonme.
```

### Prompt 3

```
make the design more readable. its overcrowded as it is
```

### Prompt 4

```
Add the ability to power on the espresso machine on a timer
```

### Prompt 5

```
add auto power-off after 60 minutes.
```

### Prompt 6

```
add the ability to add "recipes" to specific beans for further usage when I buz new beans.
```

### Prompt 7

```
add functionality to save pourover coffee recipes
```
