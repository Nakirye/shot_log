# Shot Log

Shot Log ist ein Espresso-Tagebuch: Für jeden Shot werden Bohne, Mahlgrad, Dosis, Bezugsmenge, Bezugszeit und Geschmack festgehalten. So lässt sich nachvollziehen, mit welchen Einstellungen eine Bohne oder ein Blend am besten schmeckt. Zusätzlich lässt sich die Espressomaschine über Home Assistant ein- und ausschalten, auch zeitgesteuert.

Die App ist im Rahmen einer Übung zum Thema **Vibe Coding** entstanden. Im Vordergrund stand nicht ein perfektes Endprodukt, sondern Vibe Coding selbst auszuprobieren und die Erfahrungen damit festzuhalten.

- **Verwendetes Tool:** Claude Code
- **Tech-Stack:** Frontend aus `index.html`, `styles.css` und `app.js` (Vanilla JavaScript, ohne Framework), installierbar als PWA. Ein kleiner Python-Server (nur Standardbibliothek) liefert die App aus, synchronisiert die Daten zwischen Geräten und steuert die Maschine.

## Funktionen

- **Shots erfassen:** Bohne, Datum, Mahlgrad, Bezugszeit, Dosis und Bezugsmenge (mit automatisch berechneter Brew Ratio). Optional auch Wassertemperatur, Pre-Infusion und Siebträgerkorb.
- **Geschmack bewerten:** Sterne-Bewertung, „Barista Compass“ mit Tipps zum Einstellen, Geschmacksprofil per Schieberegler, Aromen-Tags und Notizen.
- **Bohnen und Rezepte verwalten:** Bohnen anlegen, Shots nach Bohne filtern und sortieren, Espresso-Rezepte speichern und wiederverwenden. Auch Pour-over-Rezepte (z. B. V60) sind möglich.
- **Sync zwischen Geräten:** Alles wird zuerst lokal gespeichert und danach mit dem Server abgeglichen. Bei Konflikten gewinnt pro Shot bzw. Bohne die zuletzt gemachte Änderung.
- **Maschine steuern (optional):** sofort ein- und ausschalten, einmaliger Timer, Wochenplan (z. B. Mo–Fr um 06:30) und automatisches Abschalten nach 60 Minuten.
- **Offline-fähig und installierbar** als App am Handy (PWA).

## Installation & Start

Voraussetzung ist Python 3.9 oder neuer. Weitere Abhängigkeiten gibt es nicht.

```sh
python3 server.py
```

Danach ist die App unter `http://localhost:8000` erreichbar. Beim ersten Start erzeugt der Server einen **Sync-Token**, gibt ihn in der Konsole aus und speichert ihn in `data/token`. Die Daten selbst liegen in `data/shotlog.json`.

| Option / Umgebungsvariable | Standard |
|---|---|
| `--port`, `PORT` | `8000` |
| `--host` | `0.0.0.0` |
| `--data` | `./data` |
| `SHOTLOG_TOKEN` | Inhalt von `data/token`, wird beim ersten Start erzeugt |
| `--ha-url`, `HA_URL` | – (Maschinensteuerung aus) |
| `--ha-token`, `HA_TOKEN` | – |
| `--ha-entity`, `HA_ENTITY` | – |
| `--auto-off`, `AUTO_OFF_MINUTES` | `60` (`0` = nie) |

### Sync zwischen Geräten

1. In der App **Setup → Sync between devices** öffnen.
2. Den Sync-Token einfügen und auf **Save & sync** tippen. Das Feld *Server URL* bleibt leer, wenn die App direkt vom Server geöffnet wird.
3. Auf jedem weiteren Gerät wiederholen.

### Maschine einschalten (Home Assistant)

Der Server schaltet eine Home-Assistant-Entität, z. B. die smarte Steckdose der Maschine. Der Netzschalter der Maschine selbst bleibt dabei eingeschaltet.

1. In Home Assistant unter *Profil → Sicherheit → Langlebige Zugriffstoken* einen Token erstellen.
2. Den Server so starten:

   ```sh
   HA_URL=http://homeassistant.local:8123 \
   HA_TOKEN=<Token> \
   HA_ENTITY=switch.espresso_machine \
   python3 server.py
   ```

Timer und Wochenplan laufen **am Server**. Sie funktionieren also auch, wenn das Handy im Standby oder offline ist. Wochenzeiten gelten in der Zeitzone des Servers. Der Home-Assistant-Token bleibt am Server und wird nie an die App geschickt.

### Als App am Handy installieren

Browser erlauben die Installation als PWA nur über **HTTPS** (Ausnahme: `localhost`). Über `http://192.168.x.x:8000` im Heimnetz lässt sich die App zwar nutzen und synchronisieren, aber nicht installieren. HTTPS bekommt man zum Beispiel so:

- **Tailscale:** `tailscale serve --bg 8000`, dann `https://<rechner>.<tailnet>.ts.net` am Handy öffnen.
- **Reverse Proxy mit eigener Domain**, z. B. Caddy: `shots.example.com { reverse_proxy localhost:8000 }`

Nach Änderungen in `public/` muss `CACHE` in `public/sw.js` erhöht werden, damit installierte Apps die neue Version laden.

### Dateien

```
server.py                    Server: statische Dateien, Sync-API, Maschinensteuerung + Zeitplan
public/index.html            Oberfläche
public/app.js                App-Logik, Offline-Speicher, Sync-Client
public/styles.css            Styles (hell/dunkel)
public/sw.js                 Service Worker (Offline-Cache)
public/manifest.webmanifest  PWA-Manifest
public/icons/                App-Icons
```

---

## Erfahrungen mit Vibe Coding

### Was hat gut funktioniert?

- **Umfang schon nach einem Prompt:** Beeindruckend war, wie umfangreich und detailliert das Ergebnis bereits nach einem einzigen Prompt war. Die KI hat dabei viele Annahmen getroffen, zum Beispiel welche Daten ich zu einem Shot tracken möchte. In diesem Fall haben diese Annahmen größtenteils gut gepasst.
- **Die KI „denkt mit“:** Sie hat nicht nur die gestellte Aufgabe abgearbeitet, sondern auch eigene Ideen eingebracht. Die Synchronisation zwischen mehreren Geräten hat zum Beispiel die KI selbst vorgeschlagen, ich habe den Vorschlag dann mit Prompt 2 aufgegriffen. Außerdem hat sie von sich aus auf Probleme beim Setup meines Servers hingewiesen und gleich passende Lösungen mitgeliefert. Ein Beispiel ist der Hinweis, dass die App nur über HTTPS als PWA installiert werden kann, samt Lösungsvorschlägen mit Tailscale oder einem Reverse Proxy.
- **Nachvollziehbarkeit:** Die KI protokolliert sehr ausführlich, was sie gerade tut. Dadurch lässt sich gut verfolgen, welche Schritte sie setzt.
- **Zielstrebigkeit:** Die KI führt die Aufgabe, die man ihr gibt, konsequent aus, komme, was wolle. Das hat allerdings auch eine Kehrseite (siehe unten).

### Was hat nicht gut funktioniert?

- **Überladenes Design:** Nach dem ersten Prompt war die Oberfläche sehr überladen und unübersichtlich, wenn man an den Use-Case (schnelles Erfassen von Rezepten, die wichtigsten Infos auf einen Blick) denkt.
- **Keine Rückfragen bei großen Entscheidungen:** Die KI hat ohne eine einzige Rückfrage weitreichende Architekturentscheidungen getroffen und einfach als gegeben angenommen.
- **Unnötige Features:** Neben sinnvollen Parametern wurden auch Dinge eingebaut, die ich nicht brauche, zum Beispiel ein Shot-Timer direkt im Formular.
- **Design-Änderungen sind schwer zu vermitteln:** Konkrete gestalterische Änderungen in Worten so zu beschreiben, dass die KI sie wie gewünscht umsetzt, war sehr mühsam.
- **Fachliche Logikfehler:** Wer sich mit der Thematik auskennt, erkennt schnell Logikfehler. Ein Beispiel: Die App ordnet einen Shot über den „Barista Compass“ ein, also nach Extraktion (sauer bis bitter) und Stärke. Direkt darunter bewertet man denselben Shot noch einmal über eigene Schieberegler für Säure, Süße und Bitterkeit. Das ist doppelt und kann sich widersprechen. Als zweites Beispiel ist noch das Generalisieren einer "korrekten" Brew Ratio (Verhältnis Kaffeemehl:Wasser im Espresso) und Extraktionszeit zu nennen. Das ergibt keinen Sinn, denn Barista wissen, dass u.A. der Mahlgrad einen sehr großen Einfluss auf die brew ratio UND Extraktionszeit haben kann, um ein trinkbares Ergebnis erreichen zu können. Außerdem basieren jegliche Rezept-Anpassungs-Empfehlungen der App auf Abweichungen dieser über alle Rezepte generalisierten Werte.



### Welche Probleme habe ich identifiziert?

- **Verhaspeln in den eigenen Tests:** Die KI hat sich in ihren selbst geschriebenen Tests verstrickt und dabei Probleme „gefunden“, die eigentlich keine waren. Das hat unnötig Tokens verbraucht, auf das Endergebnis aber keinen negativen Einfluss gehabt.
- **Die Qualität hängt stark vom Prompt ab:** Je abstrakter die Anfrage und je weniger Informationen man der KI mitgibt, desto freier interpretiert sie die Aufgabe, und desto unbrauchbarer wird das Ergebnis. Auf den ersten Blick wirkt es durchaus beeindruckend. Sobald man genauer hinschaut, fällt das Kartenhaus aber in sich zusammen, man findet Logikfehler und Features bzw. Designentscheidungen, die aus fachlicher Perspektive wenig Sinn ergeben.
- **Expertentum:** ohne fundiertes Fachwissen (Expertenwissen) ist es schwer, die Qualität des Ergebnisses zu beurteilen. Die KI kann nicht beurteilen, ob das Endergebnis fachlich korrekt ist und Sinn ergibt. Sie kann nur die gestellte Aufgabe erledigen, "denkt" zwar mit, verfügt aber bei weitem nicht über das fundierte Fachwissen in der Thematik, das für ein gutes, praktikables Ergebnis ausschlaggebend ist.

### Erwartung vs. Realität

- **Architektur:** Ich hatte ein großes Backend erwartet. Der erste Durchlauf erzeugte lediglich eine `index.html` und eine `app.js`. Der Python-Server kam erst mit dem zweiten Prompt dazu, als es um die Synchronisation zwischen Geräten ging. Architektonisch gesehen ist diese Wahl sinnvoll: die App funktioniert mit oder ohne Server und speichert die Daten grundsätzlich lokal. KISS - keep it simple, stupid.
- **Konsistenz im Code:** Hier war ich positiv überrascht. Ich hatte erwartet, dass der Code mit jeder neuen Anfrage uneinheitlicher wird. Tatsächlich blieb er über alle Prompts und Programmiersprachen hinweg konsistent.
- **Rückfragen:** Ich hatte erwartet, dass die KI bei ungenauen Anfragen nachfragt. Stattdessen traf die KI von sich aus Annahmen, egal wie vage die Anfrage war. Die erste Rückfrage überhaupt kam erst beim Prompt *„Add the ability to power on the espresso machine on a timer“*. 

### Was wäre besser gewesen?

- **Weniger Annahmen, mehr Rückfragen:** Gerade bei grundlegenden Entscheidungen wie Architektur, Datenmodell oder Umfang wäre es sinnvoll, wenn die KI zuerst nachfragt, statt einfach anzunehmen.
- **Mehr Interaktion:** Ein stärker iterativer Ablauf, bei dem Zwischenstände abgestimmt werden, hätte vermutlich zu einem passenderen Ergebnis geführt.
- **Tests mit echten Systemen:** Statt gegen Mockup-Systeme zu testen, wären Tests mit den tatsächlichen Systemen (z. B. meiner Home-Assistant-Instanz) aussagekräftiger gewesen.
- **Kontext:** Damit das Ergebnis wirklich brauchbar wird, benötigt die KI Kontextinformationen. Der Grat zwischen zu viel und zu wenig Kontext ist schmal. Zu viel Kontext kann die Token-Nutzung unnötig erhöhen, zu wenig Kontext führt zu Annahmen, die nicht brauchbar sind.

### Fazit

Vibe Coding eignet sich sehr gut, um schnell einen beeindruckenden ersten Prototyp zu bekommen. Der produzierte Code ist fachlich korrekt. Automatische Tests helfen dabei, ein lauffähiges Endergebnis zu erhalten. Für ein wirklich brauchbares Ergebnis braucht es aber präzise Prompts, eigenes Fachwissen zur Kontrolle und die Bereitschaft, die Annahmen der KI kritisch zu hinterfragen. Die Frage "wie viel Kontext braucht die KI?" entscheidet maßgeblich über das Endergebnis.

---

## Verwendete Prompts

Alle Prompts in chronologischer Reihenfolge, unverändert so, wie ich sie in Claude Code eingegeben habe.

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
