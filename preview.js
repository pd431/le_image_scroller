// Scrub through data/slices/ as plain images. Slices are shown with <img>,
// which cannot run script, so no sanitising is needed here.
(() => {
  "use strict";
  const frame = document.getElementById("frame");
  const scrub = document.getElementById("scrub");
  const readout = document.getElementById("readout");
  const playBtn = document.getElementById("play");

  let manifest = null;
  let playing = false;
  let timer = null;

  function show(index) {
    frame.src = `data/slices/${encodeURIComponent(manifest.files[index - 1])}`;
    readout.textContent = `${index} / ${manifest.files.length}`;
    scrub.value = index;
  }

  function stopPlaying() {
    playing = false;
    playBtn.textContent = "Play";
    clearInterval(timer);
  }

  scrub.addEventListener("input", () => {
    stopPlaying();
    show(Number(scrub.value));
  });

  playBtn.addEventListener("click", () => {
    if (playing) {
      stopPlaying();
      return;
    }
    playing = true;
    playBtn.textContent = "Pause";
    timer = setInterval(() => {
      let next = Number(scrub.value) + 1;
      if (next > manifest.files.length) next = 1;
      show(next);
    }, 120);
  });

  function fail(message) {
    readout.textContent = "";
    const p = document.createElement("p");
    p.className = "error";
    p.textContent = message;
    document.body.appendChild(p);
  }

  if (location.protocol === "file:") {
    fail("This page must be served over HTTP: run `python3 -m http.server` in the project folder and open http://localhost:8000/preview.html");
  } else {
    fetch("data/slices/manifest.json")
      .then((r) => {
        if (!r.ok) throw new Error(`manifest.json returned HTTP ${r.status}`);
        return r.json();
      })
      .then((m) => {
        if (!Array.isArray(m.files) || !m.files.length) throw new Error("manifest.json lists no slices");
        manifest = m;
        scrub.max = m.files.length;
        show(1);
      })
      .catch((err) => fail(`Could not load the slice stack: ${err.message}. Run python3 scripts/build_manifest.py and reload.`));
  }
})();
