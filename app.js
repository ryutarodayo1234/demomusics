// app.js - ボツ音源プレイヤー（完全自動取得 ＆ -14 LUFS ラウドネスノーマライゼーション）
(() => {
  let tracks = [];
  let currentIndex = 0;
  let isPlaying = false;
  let isRepeating = false;
  const audio = new Audio();

  // Web Audio API（-14 LUFS ノーマライズ用）
  const TARGET_LUFS = -14.0;
  let audioCtx = null;
  let lufsGainNode = null;
  let volumeGainNode = null;
  let limiterNode = null;
  let isAudioGraphReady = false;

  // DOM要素
  const $ = (sel) => document.querySelector(sel);
  const player = $("#player");
  const trackTitle = $("#trackTitle");
  const artistName = $("#artistName");
  const trackDate = $("#trackDate");
  const lufsBadge = $("#lufsBadge");
  const playBtn = $("#playBtn");
  const backBtn = $("#backBtn");
  const skipBtn = $("#skipBtn");
  const repeatBtn = $("#repeatBtn");
  const progressBar = $("#progressBar");
  const currentTimeEl = $("#currentTime");
  const durationEl = $("#duration");
  const volumeBar = $("#volumeBar");
  const albumList = $("#album-list");
  const stats = $("#stats");

  // Web Audio APIの初期化（ユーザー操作時にアンロック）
  function initAudioGraph() {
    if (isAudioGraphReady) return;
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioContextClass();

      const sourceNode = audioCtx.createMediaElementSource(audio);
      lufsGainNode = audioCtx.createGain();
      volumeGainNode = audioCtx.createGain();
      volumeGainNode.gain.value = volumeBar.value / 100;

      // 音割れ（0dBFSクリップ）防止用リミッター
      limiterNode = audioCtx.createDynamicsCompressor();
      limiterNode.threshold.value = -0.5;
      limiterNode.knee.value = 0;
      limiterNode.ratio.value = 20;
      limiterNode.attack.value = 0.003;
      limiterNode.release.value = 0.1;

      // source -> lufsGain -> volumeGain -> limiter -> destination
      sourceNode.connect(lufsGainNode);
      lufsGainNode.connect(volumeGainNode);
      volumeGainNode.connect(limiterNode);
      limiterNode.connect(audioCtx.destination);

      isAudioGraphReady = true;
    } catch (_) {}
  }

  function resumeAudioContext() {
    initAudioGraph();
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume();
    }
  }

  // ITU-R BS.1770 K-weighting によるラウドネス（LUFS）測定
  async function measureLUFS(fileUrl) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const tempCtx = new AudioContextClass();

    try {
      const res = await fetch(fileUrl);
      const arrayBuffer = await res.arrayBuffer();
      const audioBuffer = await tempCtx.decodeAudioData(arrayBuffer);

      // K-weightingフィルタ用オフラインコンテキスト
      const offline = new OfflineAudioContext(
        audioBuffer.numberOfChannels,
        audioBuffer.length,
        audioBuffer.sampleRate
      );

      const src = offline.createBufferSource();
      src.buffer = audioBuffer;

      // Stage 1: High shelf filter (1681.97 Hz, +3.999 dB)
      const shelf = offline.createBiquadFilter();
      shelf.type = "highshelf";
      shelf.frequency.value = 1681.97;
      shelf.gain.value = 3.999;

      // Stage 2: High pass filter (38.13 Hz, Q: 0.5)
      const hpf = offline.createBiquadFilter();
      hpf.type = "highpass";
      hpf.frequency.value = 38.13;
      hpf.Q.value = 0.5;

      src.connect(shelf);
      shelf.connect(hpf);
      hpf.connect(offline.destination);
      src.start(0);

      const filtered = await offline.startRendering();

      // 各チャンネルの平均二乗パワーを算出
      let totalPower = 0;
      const step = 4; // 高速サンプリング（高精度・低負荷）
      for (let c = 0; c < filtered.numberOfChannels; c++) {
        const data = filtered.getChannelData(c);
        let sum = 0;
        for (let i = 0; i < data.length; i += step) {
          sum += data[i] * data[i];
        }
        totalPower += sum / (data.length / step);
      }

      tempCtx.close();
      if (totalPower <= 0) return -70;
      return -0.691 + 10 * Math.log10(totalPower);
    } catch (_) {
      tempCtx.close();
      return -18.0; // フォールバック想定値
    }
  }

  // -14 LUFSに合わせたゲインの適用
  async function applyLufsNormalization(track) {
    if (!lufsBadge) return;
    lufsBadge.textContent = "音量解析中...";

    const cacheKey = `lufs_${track.file}`;
    let lufs = null;

    // キャッシュ確認
    const cached = localStorage.getItem(cacheKey);
    if (cached !== null) {
      lufs = parseFloat(cached);
    } else {
      lufs = await measureLUFS(track.file);
      if (!isNaN(lufs)) {
        localStorage.setItem(cacheKey, lufs.toFixed(2));
      }
    }

    if (isNaN(lufs) || lufs < -60) lufs = -18.0;

    // ターゲット -14 LUFS との差分ゲイン
    const diffDb = TARGET_LUFS - lufs;
    const targetLinearGain = Math.pow(10, diffDb / 20);

    if (lufsGainNode && audioCtx) {
      lufsGainNode.gain.setTargetAtTime(targetLinearGain, audioCtx.currentTime, 0.05);
    }

    const sign = diffDb >= 0 ? "+" : "";
    lufsBadge.textContent = `-14 LUFS (${sign}${diffDb.toFixed(1)}dB)`;
  }

  // 自然順ソート（年・月・日・枝番の降順＝新しいものが上）
  const parseSortKey = (name) => {
    const m = name.match(/^(\d{4})_(\d{2})(\d{2})-(\d+)/);
    return m ? [parseInt(m[1]), parseInt(m[2]), parseInt(m[3]), parseInt(m[4])] : [0, 0, 0, 0];
  };

  const sortTracks = (list) => {
    return list.slice().sort((a, b) => {
      const ka = parseSortKey(a.file || a.title);
      const kb = parseSortKey(b.file || b.title);
      for (let i = 0; i < 4; i++) {
        if (ka[i] !== kb[i]) return kb[i] - ka[i];
      }
      return 0;
    });
  };

  const parseTrack = (filename) => {
    const match = filename.match(/^(\d{4})_(\d{2})(\d{2})-(\d+)\.mp3$/);
    return {
      file: filename,
      title: filename.replace(/\.mp3$/, ""),
      year: match ? parseInt(match[1]) : 0,
      date: match ? `${match[1]}.${match[2]}.${match[3]}` : ""
    };
  };

  // トラックデータの自動取得（GitHub API / ローカルAPI / ディレクトリ探索）
  async function loadTracks() {
    try {
      const res = await fetch("/api/tracks", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) return sortTracks(data);
      }
    } catch (_) {}

    if (location.hostname.endsWith("github.io")) {
      const owner = location.hostname.split(".")[0];
      const repo = location.pathname.split("/").filter(Boolean)[0];
      const cacheKey = `tracks_cache_${owner}_${repo}`;

      try {
        const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD`);
        if (res.ok) {
          const data = await res.json();
          const mp3s = (data.tree || [])
            .map((item) => item.path)
            .filter((p) => p && p.endsWith(".mp3") && !p.includes("/"))
            .map(parseTrack);

          if (mp3s.length > 0) {
            const sorted = sortTracks(mp3s);
            localStorage.setItem(cacheKey, JSON.stringify(sorted));
            return sorted;
          }
        }
      } catch (_) {}

      try {
        const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/`);
        if (res.ok) {
          const files = await res.json();
          const mp3s = files
            .filter((f) => f.name && f.name.endsWith(".mp3"))
            .map((f) => parseTrack(f.name));

          if (mp3s.length > 0) {
            const sorted = sortTracks(mp3s);
            localStorage.setItem(cacheKey, JSON.stringify(sorted));
            return sorted;
          }
        }
      } catch (_) {}

      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached);
        } catch (_) {}
      }
    }

    try {
      const res = await fetch("./");
      const html = await res.text();
      const regex = /href=["']([^"']+\.mp3)["']/gi;
      const found = [];
      let m;
      while ((m = regex.exec(html)) !== null) {
        const file = decodeURIComponent(m[1]).split("/").pop();
        if (file.endsWith(".mp3") && !found.some((t) => t.file === file)) {
          found.push(parseTrack(file));
        }
      }
      if (found.length > 0) return sortTracks(found);
    } catch (_) {}

    return [];
  }

  const formatTime = (sec) => {
    if (isNaN(sec) || sec < 0) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  };

  const setCompressed = (comp) => {
    player.classList.toggle("compressed", comp);
    sessionStorage.setItem("isPlayerCompressed", comp ? "true" : "false");
  };

  function setTrack(index, autoPlay = false) {
    if (index < 0 || index >= tracks.length) return;
    currentIndex = index;
    const t = tracks[index];

    trackTitle.textContent = t.title;
    artistName.textContent = `ボツ音源 (${t.year || ""}年)`;
    trackDate.textContent = t.date || "";

    audio.src = encodeURI(t.file);
    progressBar.value = 0;
    currentTimeEl.textContent = "0:00";
    durationEl.textContent = "0:00";

    // -14 LUFSに自動調整
    applyLufsNormalization(t);

    document.querySelectorAll(".track-list li").forEach((li) => {
      const idx = parseInt(li.getAttribute("data-index"), 10);
      li.classList.toggle("active", idx === index);
    });

    if (autoPlay) {
      resumeAudioContext();
      audio.play().then(() => {
        isPlaying = true;
        playBtn.textContent = "⏸";
      }).catch(() => {});
    }
  }

  function renderList() {
    albumList.innerHTML = "";
    if (tracks.length === 0) {
      albumList.innerHTML = `<div class="empty-msg">mp3を読み込み中、または見つかりませんでした</div>`;
      stats.textContent = "0曲";
      return;
    }

    stats.textContent = `全 ${tracks.length} 曲（最新順）`;

    const groups = {};
    tracks.forEach((t, index) => {
      const y = t.year || "その他";
      if (!groups[y]) groups[y] = [];
      groups[y].push({ ...t, globalIndex: index });
    });

    const years = Object.keys(groups).sort((a, b) => b - a);

    years.forEach((year, yIdx) => {
      const yearTracks = groups[year];
      const album = document.createElement("div");
      album.className = "album";

      const isOpen = yIdx === 0;
      album.innerHTML = `
        <div class="album-header">
          <div class="album-title">
            <span class="year-label">${year}年</span>
            <span class="count-badge">${yearTracks.length}曲</span>
          </div>
          <button class="toggle-btn" aria-label="開閉">${isOpen ? "−" : "＋"}</button>
        </div>
        <ul class="track-list" style="display: ${isOpen ? "block" : "none"}">
          ${yearTracks.map((t) => `
            <li data-index="${t.globalIndex}" class="${t.globalIndex === currentIndex ? "active" : ""}">
              <span class="track-name">${t.title}</span>
              <span class="track-meta">${t.date}</span>
            </li>
          `).join("")}
        </ul>
      `;

      const header = album.querySelector(".album-header");
      const list = album.querySelector(".track-list");
      const toggle = album.querySelector(".toggle-btn");

      header.addEventListener("click", () => {
        const open = list.style.display !== "none";
        list.style.display = open ? "none" : "block";
        toggle.textContent = open ? "＋" : "−";
      });

      list.querySelectorAll("li").forEach((li) => {
        li.addEventListener("click", () => {
          resumeAudioContext();
          const idx = parseInt(li.getAttribute("data-index"), 10);
          setTrack(idx, true);
        });
      });

      albumList.appendChild(album);
    });
  }

  function initEvents() {
    playBtn.addEventListener("click", () => {
      resumeAudioContext();
      if (isPlaying) {
        audio.pause();
        playBtn.textContent = "▶";
      } else {
        audio.play();
        playBtn.textContent = "⏸";
      }
      isPlaying = !isPlaying;
    });

    audio.addEventListener("timeupdate", () => {
      if (!audio.duration) return;
      progressBar.value = (audio.currentTime / audio.duration) * 100;
      currentTimeEl.textContent = formatTime(audio.currentTime);
      durationEl.textContent = formatTime(audio.duration);
    });

    audio.addEventListener("loadedmetadata", () => {
      durationEl.textContent = formatTime(audio.duration);
    });

    progressBar.addEventListener("input", () => {
      if (audio.duration) {
        audio.currentTime = (progressBar.value / 100) * audio.duration;
      }
    });

    // 音量操作
    volumeBar.addEventListener("input", (e) => {
      const vol = e.target.value / 100;
      if (volumeGainNode && audioCtx) {
        volumeGainNode.gain.setValueAtTime(vol, audioCtx.currentTime);
      }
      audio.volume = vol;
    });

    skipBtn.addEventListener("click", () => {
      resumeAudioContext();
      setTrack(currentIndex < tracks.length - 1 ? currentIndex + 1 : 0, true);
    });

    backBtn.addEventListener("click", () => {
      resumeAudioContext();
      if (audio.currentTime > 3 || currentIndex === 0) {
        audio.currentTime = 0;
      } else {
        setTrack(currentIndex - 1, true);
      }
    });

    audio.addEventListener("ended", () => {
      if (isRepeating) {
        audio.currentTime = 0;
        audio.play();
      } else {
        skipBtn.click();
      }
    });

    repeatBtn.addEventListener("click", () => {
      isRepeating = !isRepeating;
      repeatBtn.classList.toggle("active", isRepeating);
      repeatBtn.textContent = isRepeating ? "🔂" : "🔁";
    });

    $("#compress-bar").addEventListener("click", () => {
      setCompressed(!player.classList.contains("compressed"));
    });

    if (sessionStorage.getItem("isPlayerCompressed") === "true") {
      setCompressed(true);
    }
  }

  async function init() {
    initEvents();
    tracks = await loadTracks();
    renderList();
    if (tracks.length > 0) {
      setTrack(0, false);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
