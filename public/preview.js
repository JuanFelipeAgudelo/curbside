/* /?preview: a made-up run that plays the motion studies on a real phone, so
   each stage can be seen without waiting for a real flight to move. Loaded by
   app.js only with ?preview. The run, its people and its flights are invented;
   the times are set around now so it is always in progress.

   Nothing leaves the page: PREVIEW stops loadAssignments, enqueue and flush,
   the saved copy is never written (applyAssignments(…, true)), and every
   control that could edit, import or change a setting is blocked here. */
(function preview() {
  const STEP_MS = 6000;
  // /?preview&tour: the testers' guide (/alpha/) shows this in a phone frame
  // and picks each scene from its own steps; no pill, no timer.
  const TOUR = new URLSearchParams(location.search).has("tour") && window.parent !== window;
  // The guide's frame forbids the wake lock (a guide must not keep a screen
  // on); without this, every repaint asks again and logs a policy error.
  if (TOUR) try { Object.defineProperty(navigator, "wakeLock", { value: undefined, configurable: true }); } catch { /* asks, and is refused */ }

  /* ---- the run, on the running clock (minutes, see wallAt) ---- */
  const base = nowAt();
  const stamp = (min) => new Date(min * 60000).toISOString().slice(0, 16).replace("T", " ");
  const day = (min) => stamp(min).slice(0, 10);
  const ampm = (min) => {
    const m = ((Math.round(min) % 1440) + 1440) % 1440;
    const h = Math.floor(m / 60), mm = String(m % 60).padStart(2, "0");
    return `${h % 12 || 12}:${mm} ${h < 12 ? "AM" : "PM"}`;
  };

  const LAND_A = base + 50;  // UA 1234 from Chicago, the one that moves
  const LAND_B = base + 65;  // B6 88 from Orlando, the steady one
  const leg = (min, extra) => Object.assign({
    airport: "Newark", airportCode: "EWR", countryCode: "US", timeZone: "America/New_York",
    scheduledTime: stamp(min), estimatedTime: stamp(min),
    scheduledTimeUtc: null, estimatedTimeUtc: null,
    terminal: null, gate: null, baggageBelt: null,
  }, extra);
  const from = (airport, code, min) => leg(min - 150, { airport, airportCode: code });

  const run = {
    number: "PREVIEW", driver: "Preview", gb: false, source: "preview",
    start: stamp(base - 30), end: stamp(base + 180),
    vehicle: "SIENNA 00000", parking: "Lot B", issues: [],
    driverNotes: "A made-up run. Nothing you do here is saved.",
    printedAt: stamp(base - 600), importedAt: stamp(base - 590),
    steps: [
      { _at: "0", code: "WRK", place: "Warwick", address: "1 Sample Road",
        date: day(base - 30), etd: ampm(base - 30), eta: null, actions: [] },
      { _at: "1", code: "EWR", place: "Newark", address: "Terminal C",
        date: day(base + 80), etaDate: day(base + 35), eta: ampm(base + 35), etd: ampm(base + 110),
        actions: [{ _at: "1.0", verb: "Pickup", where: "Terminal C arrivals, door 4", entities: [
          { _at: "1.0.0", name: "Sample, Ana", pax: 1, tag: "A", gb: false, origin: "Chicago",
            destination: "Warwick", phone: "555-0100", bags: 2, flightNumber: "UA1234",
            flightDate: day(LAND_A), scheduledText: `${ampm(LAND_A)} ORD - Chicago` },
          { _at: "1.0.1", name: "Example, Ben", pax: 1, tag: "A", gb: false, origin: "Orlando",
            destination: "Warwick", phone: "555-0101", bags: 1, flightNumber: "B688",
            flightDate: day(LAND_B), scheduledText: `${ampm(LAND_B)} MCO - Orlando` },
        ] }] },
      { _at: "2", code: "WRK", place: "Warwick", address: "1 Sample Road",
        date: day(base + 180), etaDate: day(base + 180), eta: ampm(base + 180), etd: null,
        actions: [{ _at: "2.0", verb: "Drop-Off", where: "Main lobby", entities: [] }] },
    ],
  };

  // When the flights were last "checked": moved only by scenes that change
  // them, so the fresh dot pulses (M3) when data really arrives.
  let fetchedAt = new Date().toISOString();
  function statuses(a, b) {
    const s = (flightNumber, airline, dep, arr, st) => ({
      flightNumber, date: arr.scheduledTime.slice(0, 10), status: st, airline,
      departure: dep, arrival: arr, fetchedAt });
    return {
      [`UA1234:${day(LAND_A)}`]: s("UA1234", "United Airlines",
        from("Chicago O'Hare", "ORD", LAND_A), leg(LAND_A, a), a.status || "Expected"),
      [`B688:${day(LAND_B)}`]: s("B688", "JetBlue Airways",
        from("Orlando", "MCO", LAND_B), leg(LAND_B, b), b.status || "Expected"),
    };
  }

  /* The preview's own clock: a scene can jump it ahead, so the run moves on
     to its next stop (M1) without waiting for it. The run above was laid out
     on the real clock first. */
  let ahead = 0;
  const realNowAt = nowAt;
  nowAt = (now) => realNowAt(now) + ahead;

  /* ---- what changes, one scene every few seconds, then round again ---- */
  const BASE = { terminal: "C" };
  const ben = (r) => r.steps[1].actions[0].entities[1];
  const door = (r) => r.steps[1].actions[0];
  const fixDoor = (pending) => (r) => {
    door(r).where = "Terminal C arrivals, door 5";
    door(r)._edit = { where: { pending, documentValue: "Terminal C arrivals, door 4" } };
  };
  // A shuttle, made up in 374819's shape: a stop with no address is a window,
  // the timed lines in the notes are its legs, and the codes they name have no
  // address yet, so the route asks for them.
  const noted = (min) => ampm(min).replace(/ ([AP])M$/, (_, x) => x.toLowerCase()); // "9:36p"
  const shuttle = (r) => {
    delete r.lines; // read again from these notes
    Object.assign(r, {
      start: stamp(base - 10), end: stamp(base + 100),
      driverNotes: [
        `${noted(base + 6)} NTH to STH.`,
        `${noted(base + 25)} Depart STH, drop at LIB on request.`,
        `${noted(base + 50)}* or 5 min after the meeting ends, LIB to NTH.`,
        `${noted(base + 70)} NTH to WRK.`,
        "A made-up run. Nothing you do here is saved.",
      ].join("\n"),
      steps: [
        { _at: "0", code: "SHU", place: "Campus Shuttle", address: "",
          date: day(base + 75), etaDate: day(base - 10), eta: ampm(base - 10), etd: ampm(base + 75), actions: [] },
        { _at: "1", code: "WRK", place: "Warwick", address: "1 Sample Road",
          date: day(base + 85), etaDate: day(base + 85), eta: ampm(base + 85), etd: null,
          actions: [{ _at: "1.0", verb: "Drop-Off", where: "Main lobby", entities: [] }] },
      ],
    });
  };
  // v61: dispatch re-sent the sheet with the pickup 5 minutes earlier and
  // another door, as the worker's diff (changes.ts) would serve it.
  const resent = (r) => {
    const ewr = r.steps[1];
    const times = (eta) => ({ eta, etd: ewr.etd, date: ewr.date, etaDate: ewr.etaDate });
    r.printedAt = stamp(base - 120);
    r.sheetChanges = { since: stamp(base - 600), count: 2, seen: false, run: {}, items: [
      { kind: "times", at: "1", code: "EWR", was: times(ampm(base + 40)), now: times(ewr.eta) },
      { kind: "place", at: "1", code: "EWR", was: {}, now: { place: ewr.place, address: ewr.address },
        doors: [{ at: "1.0", was: { verb: "Pickup", where: "Terminal C arrivals, door 2" },
          now: { verb: "Pickup", where: door(r).where } }] },
    ] };
  };
  // v63: Ana was messaged the evening before; then dispatch moved her door
  // (an arrival's time is her flight's, so the door is what her message said).
  const messagedThenMoved = (r) => {
    called[ANA] = { at: new Date(Date.now() - 14 * 3600e3).toISOString(), said: saidOf(r, r.steps[1].actions[0].entities[0]) };
    door(r).where = "Terminal C arrivals, door 7";
  };
  const scenes = [
    { say: "", fetch: true, a: BASE, b: BASE },
    { say: "UA 1234 delayed 12 minutes", fetch: true, a: { terminal: "C", estimatedTime: stamp(LAND_A + 12), status: "Delayed" }, b: { terminal: "C" } },
    { say: "A gate is published", fetch: true, a: { terminal: "C", gate: "C71", estimatedTime: stamp(LAND_A + 12), status: "Delayed" }, b: { terminal: "C" } },
    { say: "Belts assigned", fetch: true, a: { terminal: "C", gate: "C71", baggageBelt: "4", estimatedTime: stamp(LAND_A + 12), status: "Delayed" }, b: { terminal: "C", gate: "C102", baggageBelt: "7" } },
    { say: "Belt moved, and it's landing early", fetch: true, a: { terminal: "C", gate: "C71", baggageBelt: "6", estimatedTime: stamp(LAND_A - 6), status: "Expected" }, b: { terminal: "C", gate: "C102", baggageBelt: "7" } },
    // Past Leaving EWR (B6 88 lands +65, +45m bags): the run moves on to WRK.
    { say: "Two hours later: on to Warwick", ahead: 120, a: { terminal: "C", gate: "C71", baggageBelt: "6", estimatedTime: stamp(LAND_A - 6), status: "Landed" }, b: { terminal: "C", gate: "C102", baggageBelt: "7", status: "Landed" } },
    { say: "Back to the start", fetch: true, a: BASE, b: BASE },
    // Stage 3: an edit waiting for signal, then landing; a row removed, then undone.
    { say: "No signal: you fixed the door", a: BASE, b: BASE, mut: fixDoor(true) },
    { say: "Signal's back: the fix is sent", a: BASE, b: BASE, mut: fixDoor(false) },
    { say: "Ben marked not coming", a: BASE, b: BASE, mut: (r) => { ben(r)._removed = { patchId: "preview", pending: false }; } },
    { say: "Undone: Ben's back", a: BASE, b: BASE },
    // Stage 4: a GB run shown for the first time; the day's first launch.
    // (The messages tick is live here: the pill's MESSAGES, then tick.)
    { say: "A Governing Body run, seen for the first time", a: BASE, b: BASE, gb: true, mut: (r) => { r.gb = true; } },
    { say: "Tomorrow's first launch, after 4 AM", a: BASE, b: BASE, splash: true },
    { say: "A shuttle: the notes are its legs", a: BASE, b: BASE, mut: shuttle },
    // v65: added at the end, so the guide's scene numbers above stay put.
    { say: "Dispatch re-sent it: what changed is marked", a: BASE, b: BASE, mut: resent },
    { say: "Messaged Ana, then her pickup moved", a: BASE, b: BASE, mut: messagedThenMoved },
    { say: "Removed from this phone: UNDO waits on the list", a: BASE, b: BASE, hide: true },
  ];

  let i = 0;
  function play() {
    const scene = scenes[i % scenes.length];
    ahead = scene.ahead || 0;
    if (scene.fetch) fetchedAt = new Date().toISOString();
    const r = structuredClone(run);
    if (typeof called[ANA] === "object") delete called[ANA]; // the scene's own tick, not the viewer's
    if (scene.mut) scene.mut(r);
    if (scene.gb) gbShown.delete(r.number); // "the first time", every round
    // A hidden run is on the list only, as its ghost card: its page is gone.
    assignments = scene.hide ? [] : [r];
    hiddenRuns = scene.hide ? [r] : [];
    flightStatuses = statuses(scene.a, scene.b);
    renderCurrent();
    if (TOUR) return;
    note.textContent = scene.splash && !replaySplash() ? "Reduce motion is on: no splash"
      : scene.say || "Watch the times and the gate row";
    i++;
  }

  /* ---- nothing here may change the real list ---- */
  // Calls are ticked in this page's memory only, never in the saved log.
  const called = {};
  const ANA = "PREVIEW:Sample, Ana";
  // The hidden scene's run was hidden here, from this very print.
  hiddenEntry = (number) => (number === run.number ? { at: new Date().toISOString(), printedAt: run.printedAt } : null);
  calledLog = () => ({ ...called });
  markCalled = (number, name, on) => {
    if (on) called[`${number}:${name}`] = new Date().toISOString();
    else delete called[`${number}:${name}`];
  };
  const ALLOWED = "#itin-back, .acard, [data-collapsible] .sthead, #preview-exit, #update-btn, "
    + "#calls-back, #calls-prev, #calls-next, [data-call] .tickbox";
  const BLOCKED = "#main button, #main a, #main [data-tick], #import-btn, #settings-btn";
  document.addEventListener("click", (e) => {
    const t = e.target.closest(BLOCKED);
    if (t && !e.target.closest(ALLOWED)) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  for (const type of ["dragenter", "dragover", "drop"]) {
    document.addEventListener(type, (e) => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
  }

  applyAssignments({ assignments: [run], statuses: statuses(scenes[0].a, scenes[0].b) }, true);
  offline = false;

  if (TOUR) {
    window.addEventListener("message", (e) => {
      if (e.origin !== location.origin || typeof e.data?.tourScene !== "number") return;
      i = e.data.tourScene;
      play();
      // After the repaint (the stop advance is a view transition), and not
      // scrollIntoView: that would scroll the guide's own page too.
      // In a frame both <html> and <body> scroll, so setPageScroll moves it
      // twice: scroll the body, and <html> only by what the body can't.
      const aim = () => {
        const el = e.data.scrollTo && document.querySelector(e.data.scrollTo);
        const b = document.body, h = document.documentElement;
        const y = el ? el.getBoundingClientRect().top + b.scrollTop + h.scrollTop - 12 : 0;
        b.scrollTop = y;
        h.scrollTop = Math.max(0, y - b.scrollTop);
      };
      setTimeout(aim, 40);
      setTimeout(aim, 420);
    });
    window.parent.postMessage({ tourReady: true }, location.origin);
    return;
  }

  const style = document.createElement("style");
  style.textContent = `
    #preview-pill {
      position: fixed; left: 12px; right: 12px; z-index: 35;
      bottom: calc(12px + env(safe-area-inset-bottom, 0px));
      display: flex; align-items: center; gap: 10px; padding: 10px 12px;
      background: var(--panel-raised); border: 1px solid var(--hairline-strong); border-radius: 12px;
      font-size: 12.5px; color: var(--ink-2); max-width: 496px; margin: 0 auto;
    }
    #preview-pill > span { flex: 1; min-width: 0; }
    #preview-pill b { font-size: 11px; letter-spacing: 0.08em; color: var(--ink); margin-right: 6px; }
    #main { padding-bottom: 72px; }`;
  document.head.append(style);

  const pill = document.createElement("div");
  pill.id = "preview-pill";
  pill.innerHTML = `<span><b>MOTION PREVIEW</b> <span id="preview-note"></span></span>
    <button class="mini-btn" type="button" id="preview-calls">MESSAGES</button>
    <button class="mini-btn" type="button" id="preview-exit">EXIT</button>`;
  document.body.append(pill);
  const note = document.getElementById("preview-note");
  document.getElementById("preview-exit").addEventListener("click", () => { location.href = "/"; });
  // The run is under way, so the list has no messages bar: this opens its day's.
  document.getElementById("preview-calls").addEventListener("click", () => renderCalls(day(base)));

  play();
  setInterval(() => { if (document.visibilityState === "visible") play(); }, STEP_MS);
})();
