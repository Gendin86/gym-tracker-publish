const DB_NAME = "gym-tracker-db";
const DB_VERSION = 1;
const CONFIG_KEY_YANDEX_DISK = "yandexDisk";
const YANDEX_OAUTH_URL = "https://oauth.yandex.ru/authorize";
const YANDEX_DISK_API_BASE = "https://cloud-api.yandex.net/v1/disk";
const YANDEX_CLIENT_ID = "58b25467f55b45378ba1f29efea3d956";
const DEFAULT_YANDEX_BACKUP_FOLDER = "app:/gym-tracker-backups";
const APP_TIME_ZONE = "Europe/Moscow";
const MAX_YANDEX_BACKUPS = 3;
const EXERCISE_GROUPS = ["Грудь", "Спина", "Ноги", "Другое"];

const state = {
  view: "home",
  exercises: [],
  sessions: [],
  activeSession: null,
  deferredPrompt: null,
  modal: null,
  pendingFocus: null,
  yandexDisk: createDefaultYandexDiskConfig(),
  yandexBackups: [],
};

let db;

const app = document.querySelector("#app");
const installBtn = document.querySelector("#installBtn");
const navButtons = Array.from(document.querySelectorAll(".nav-btn"));
const modalRoot = document.querySelector("#modalRoot");
const importInput = document.querySelector("#importInput");
const importTxtInput = document.querySelector("#importTxtInput");

document.addEventListener("DOMContentLoaded", init);

async function init() {
  await initDb();
  await handleYandexOAuthRedirect();
  await loadState();
  bindGlobalEvents();
  render();
  if (!isNativeApp()) {
    registerServiceWorker();
  }
}

function bindGlobalEvents() {
  navButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      render();
    });
  });

  installBtn.addEventListener("click", async () => {
    if (installBtn.dataset.mode === "ios-help") {
      state.modal = { type: "install-help" };
      renderModal();
      return;
    }

    if (!state.deferredPrompt) return;
    state.deferredPrompt.prompt();
    await state.deferredPrompt.userChoice;
    state.deferredPrompt = null;
    installBtn.classList.add("hidden");
  });

  window.addEventListener("beforeinstallprompt", (event) => {
    if (isStandaloneApp()) return;
    event.preventDefault();
    state.deferredPrompt = event;
    installBtn.dataset.mode = "prompt";
    installBtn.textContent = "Установить";
    installBtn.classList.remove("hidden");
  });

  if (isStandaloneApp()) {
    installBtn.classList.add("hidden");
  } else if (shouldShowIosInstallHelp()) {
    installBtn.dataset.mode = "ios-help";
    installBtn.textContent = "На экран Домой";
    installBtn.classList.remove("hidden");
  }

  importInput.addEventListener("change", importBackup);
  importTxtInput.addEventListener("change", importExerciseLibraryFromTxt);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const upgradeDb = request.result;
      if (!upgradeDb.objectStoreNames.contains("config")) {
        upgradeDb.createObjectStore("config", { keyPath: "key" });
      }
      if (!upgradeDb.objectStoreNames.contains("days")) {
        upgradeDb.createObjectStore("days", { keyPath: "id" });
      }
      if (!upgradeDb.objectStoreNames.contains("exercises")) {
        upgradeDb.createObjectStore("exercises", { keyPath: "id" });
      }
      if (!upgradeDb.objectStoreNames.contains("sessions")) {
        upgradeDb.createObjectStore("sessions", { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function initDb() {
  db = await openDb();
}

function store(name, mode = "readonly") {
  return db.transaction(name, mode).objectStore(name);
}

function getAll(name) {
  return new Promise((resolve, reject) => {
    const request = store(name).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getOne(name, key) {
  return new Promise((resolve, reject) => {
    const request = store(name).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function put(name, value) {
  return new Promise((resolve, reject) => {
    const request = store(name, "readwrite").put(value);
    request.onsuccess = () => resolve(value);
    request.onerror = () => reject(request.error);
  });
}

function del(name, key) {
  return new Promise((resolve, reject) => {
    const request = store(name, "readwrite").delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function clearStore(name) {
  return new Promise((resolve, reject) => {
    const request = store(name, "readwrite").clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function loadState() {
  const [exercises, sessions, yandexDiskConfig] = await Promise.all([
    getAll("exercises"),
    getAll("sessions"),
    getConfig(CONFIG_KEY_YANDEX_DISK),
  ]);

  state.exercises = exercises
    .map((exercise) => ({ ...exercise, group: exercise.group || "Другое" }))
    .sort((a, b) => {
      const groupCompare = a.group.localeCompare(b.group, "ru");
      if (groupCompare !== 0) return groupCompare;
      return a.name.localeCompare(b.name, "ru");
    });
  state.sessions = sessions.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  state.activeSession = state.sessions.find((item) => item.status === "active") ?? null;
  state.yandexDisk = normalizeYandexDiskConfig(yandexDiskConfig);
}

function createDefaultYandexDiskConfig() {
  return {
    clientId: YANDEX_CLIENT_ID,
    folder: DEFAULT_YANDEX_BACKUP_FOLDER,
    accessToken: "",
    connectedAt: "",
    expiresAt: "",
    lastSyncAt: "",
    lastBackupName: "",
    lastSyncError: "",
    authPromptShown: false,
  };
}

function normalizeYandexDiskConfig(config) {
  return {
    ...createDefaultYandexDiskConfig(),
    ...(config?.value || {}),
    folder: DEFAULT_YANDEX_BACKUP_FOLDER,
  };
}

function getConfig(key) {
  return getOne("config", key);
}

async function setConfig(key, value) {
  await put("config", { key, value });
}

async function saveYandexDiskConfig(patch) {
  state.yandexDisk = {
    ...state.yandexDisk,
    ...patch,
  };
  await setConfig(CONFIG_KEY_YANDEX_DISK, state.yandexDisk);
}

async function handleYandexOAuthRedirect() {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const accessToken = hash.get("access_token");
  if (!accessToken) return;

  const expiresIn = Number(hash.get("expires_in") || 0);
  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : "";
  const existing = normalizeYandexDiskConfig(await getConfig(CONFIG_KEY_YANDEX_DISK));

  await setConfig(CONFIG_KEY_YANDEX_DISK, {
    ...existing,
    accessToken,
    connectedAt: new Date().toISOString(),
    expiresAt,
  });

  history.replaceState({}, document.title, window.location.pathname + window.location.search);
}

function getYandexRedirectUri() {
  return window.location.origin === "null"
    ? window.location.href.split("#")[0]
    : `${window.location.origin}${window.location.pathname}`;
}

function getYandexDiskFileName() {
  const now = getDateTimeParts(new Date());
  const datePart = `${now.year}-${now.month}-${now.day}`;
  const timePart = `${now.hour}-${now.minute}-${now.second}`;
  return `Тренировки-${datePart}_${timePart}.json`;
}

function buildBackupPayload() {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    exercises: state.exercises,
    sessions: state.sessions,
  };
}

function buildBackupBlob() {
  return new Blob([JSON.stringify(buildBackupPayload(), null, 2)], { type: "application/json" });
}

function isYandexDiskConnected() {
  return Boolean(state.yandexDisk.accessToken);
}

function getCloudBackupFolder() {
  return DEFAULT_YANDEX_BACKUP_FOLDER;
}

async function yandexDiskRequest(path, { method = "GET", params, headers, body, raw = false } = {}) {
  if (!state.yandexDisk.accessToken) {
    throw new Error("Сначала подключите Яндекс Диск.");
  }

  const url = new URL(`${YANDEX_DISK_API_BASE}${path}`);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, value);
      }
    });
  }

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `OAuth ${state.yandexDisk.accessToken}`,
      ...headers,
    },
    body,
  });

  if (!response.ok) {
    let message = "Не удалось выполнить запрос к Яндекс Диску.";
    try {
      const errorData = await response.json();
      message = errorData.description || errorData.message || message;
    } catch {}
    if (/forbidden/i.test(message) || response.status === 403) {
      message = "Яндекс Диск отклонил доступ. Проверьте авторизацию приложения и разрешения.";
    } else if (/unauthorized/i.test(message) || response.status === 401) {
      message = "Сессия Яндекс Диска истекла. Подключите Яндекс Диск заново.";
    } else if (/not found/i.test(message) || response.status === 404) {
      message = "Нужная папка или резервная копия не найдена на Яндекс Диске.";
    } else if (/conflict/i.test(message) || response.status === 409) {
      message = "На Яндекс Диске возник конфликт при сохранении данных.";
    }
    const requestError = new Error(message);
    requestError.status = response.status;
    throw requestError;
  }

  if (raw) return response;
  if (response.status === 204) return null;
  return response.json();
}

async function ensureYandexFolder(folderPath) {
  const normalized = folderPath.replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length < 2) return;

  let current = parts[0];
  for (let index = 1; index < parts.length; index += 1) {
    current = `${current}/${parts[index]}`;
    try {
      await yandexDiskRequest("/resources", {
        method: "PUT",
        params: { path: current },
      });
    } catch (error) {
      if (!(error instanceof Error) || (error.status !== 409 && !/уже существует|exists|Conflict/i.test(error.message))) {
        throw error;
      }
    }
  }
}

async function uploadBackupToYandexDisk() {
  const folder = getCloudBackupFolder();
  await ensureYandexFolder(folder);

  const fileName = getYandexDiskFileName();
  const remotePath = `${folder}/${fileName}`;
  const uploadMeta = await yandexDiskRequest("/resources/upload", {
    params: {
      path: remotePath,
      overwrite: "true",
    },
  });

  const uploadResponse = await fetch(uploadMeta.href, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: buildBackupBlob(),
  });

  if (!uploadResponse.ok) {
    throw new Error("Не удалось загрузить резервную копию в Яндекс Диск.");
  }

  await saveYandexDiskConfig({
    lastSyncAt: new Date().toISOString(),
    lastBackupName: fileName,
    lastSyncError: "",
  });

  await pruneYandexBackups();

  return fileName;
}

async function loadYandexBackups() {
  let response;
  try {
    response = await yandexDiskRequest("/resources", {
      params: {
        path: getCloudBackupFolder(),
        limit: "100",
      },
    });
  } catch (error) {
    if (error instanceof Error && /не найден|not found/i.test(error.message)) {
      state.yandexBackups = [];
      return [];
    }
    throw error;
  }

  const items = (response?._embedded?.items || [])
    .filter((item) => item.type === "file" && item.name.endsWith(".json"))
    .sort((a, b) => new Date(b.modified || b.created || 0) - new Date(a.modified || a.created || 0));

  state.yandexBackups = items;
  return items;
}

async function pruneYandexBackups() {
  const backups = await loadYandexBackups();
  const staleBackups = backups.slice(MAX_YANDEX_BACKUPS);

  for (const item of staleBackups) {
    await yandexDiskRequest("/resources", {
      method: "DELETE",
      params: {
        path: item.path,
        permanently: "true",
        force_async: "false",
      },
    }).catch((error) => {
      console.warn("Не удалось удалить старую резервную копию", error);
    });
  }

  if (staleBackups.length) {
    await loadYandexBackups();
  }
}

async function restoreBackupFromYandexDisk(remotePath, targetWindow = null) {
  const downloadMeta = await yandexDiskRequest("/resources/download", {
    params: { path: remotePath },
  });
  if (targetWindow && !targetWindow.closed) {
    targetWindow.location.replace(downloadMeta.href);
    return;
  }

  window.location.href = downloadMeta.href;
}

async function applyImportedBackup(data) {
  if (!Array.isArray(data.exercises) || !Array.isArray(data.sessions)) {
    throw new Error("Некорректный файл резервной копии.");
  }

  await clearStore("exercises");
  await clearStore("sessions");
  await Promise.all(data.exercises.map((exercise) => put("exercises", exercise)));
  await Promise.all(data.sessions.map((session) => put("sessions", session)));
  await refreshState();
}

function render() {
  navButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.view);
  });

  if (state.view === "history") {
    renderHistory();
  } else {
    renderHome();
  }
  if (state.view === "workout") renderWorkout();
  renderModal();
}

function renderHome() {
  const completed = state.sessions.filter((item) => item.status === "completed");

  app.innerHTML = `
    <section class="view">
      <section class="summary-grid">
        <article class="summary-tile">
          <p class="muted">Завершено тренировок</p>
          <h3>${completed.length}</h3>
        </article>
      </section>

      <section class="card stack">
        <div class="title-row">
          <h3>${state.activeSession ? "Активная тренировка" : "Быстрый старт"}</h3>
          ${state.activeSession ? '<span class="badge">Не завершена</span>' : ""}
        </div>
        <div class="stack">
          ${state.activeSession
            ? '<button class="primary full" data-action="resume-workout" type="button">Продолжить</button>'
            : '<button class="primary full" data-action="start-workout" type="button">Начать тренировку</button>'}
        </div>
      </section>

      <section class="card stack">
        <div class="title-row">
          <h3>Последние тренировки</h3>
          <button class="ghost" data-action="open-history" type="button">Вся история</button>
        </div>
        <div class="history-list">
          ${completed.slice(0, 3).map(renderSessionPreview).join("") || renderEmpty("История появится после первой тренировки.")}
        </div>
      </section>

      <section class="card stack">
        <div class="title-row">
          <h3>Справочник</h3>
          <span class="badge">${state.exercises.length}</span>
        </div>
        <button class="secondary full" data-action="open-library" type="button">Открыть справочник</button>
        <div class="item stack compact-gap">
          <strong>Как это работает</strong>
          <span class="muted">Добавьте упражнения в справочник вручную или загрузите списком из текстового файла по шаблону. После подключения Яндекс Диска приложение будет автоматически загружать резервные копии в облако после завершения тренировки.</span>
        </div>
        <div class="row-wrap equal-actions">
          <button class="ghost" data-action="import-library-txt" type="button">Загрузить список</button>
          <button class="ghost" data-action="download-library-template" type="button">Скачать шаблон</button>
        </div>
        <button class="ghost full" data-action="restore-from-cloud" type="button">Восстановить из облака</button>
        <button class="ghost full" data-action="open-yandex-disk" type="button">Яндекс Диск</button>
      </section>
    </section>
  `;

  bindHomeEvents();
}

function bindHomeEvents() {
  app.querySelector('[data-action="open-library"]').addEventListener("click", () => {
    state.modal = { type: "exercise-library" };
    renderModal();
  });

  app.querySelector('[data-action="open-history"]').addEventListener("click", () => {
    state.view = "history";
    render();
  });

  app.querySelector('[data-action="resume-workout"]')?.addEventListener("click", () => {
    state.view = "workout";
    render();
  });

  app.querySelector('[data-action="start-workout"]')?.addEventListener("click", () => startWorkout());

  app.querySelector('[data-action="restore-from-cloud"]').addEventListener("click", handleCloudRestoreRequest);
  app.querySelector('[data-action="open-yandex-disk"]').addEventListener("click", openYandexDiskModal);
  app.querySelector('[data-action="import-library-txt"]').addEventListener("click", () => importTxtInput.click());
  app.querySelector('[data-action="download-library-template"]').addEventListener("click", downloadLibraryTemplate);
}

function renderWorkout() {
  if (!state.activeSession) {
    state.view = "home";
    render();
    return;
  }

  app.innerHTML = `
    <section class="view">
      <section class="card stack">
        <div class="title-row">
          <h2>Тренировка</h2>
          <span class="badge">${formatDate(state.activeSession.startedAt)}</span>
        </div>
        <div class="row-wrap equal-actions">
          <button class="secondary" data-action="add-workout-exercise" type="button">Добавить упражнение</button>
          <button class="primary" data-action="finish-workout" type="button">Завершить тренировку</button>
        </div>
        <button class="ghost full" data-action="go-home" type="button">На главный экран</button>
      </section>

      <section class="exercise-list">
        ${state.activeSession.entries.map(renderWorkoutExercise).join("") || renderEmpty("В этом тренировочном дне нет упражнений.")}
      </section>
    </section>
  `;

  bindWorkoutEvents();
}

function bindWorkoutEvents() {
  app.querySelector('[data-action="add-workout-exercise"]').addEventListener("click", () => {
    state.modal = { type: "workout-exercise-picker" };
    renderModal();
  });
  app.querySelector('[data-action="finish-workout"]').addEventListener("click", finishWorkout);
  app.querySelector('[data-action="go-home"]').addEventListener("click", () => {
    state.view = "home";
    render();
  });

  app.querySelectorAll("[data-action='add-set']").forEach((button) => {
    button.addEventListener("click", async () => {
      const entry = state.activeSession.entries.find((item) => item.exerciseId === button.dataset.exerciseId);
      const newSet = createEmptySet();
      entry.sets.push(newSet);
      state.pendingFocus = {
        exerciseId: button.dataset.exerciseId,
        setId: newSet.id,
        field: "weight",
      };
      await persistActiveSession();
      renderWorkout();
    });
  });

  app.querySelectorAll("[data-action='remove-workout-exercise']").forEach((button) => {
    button.addEventListener("click", async () => {
      state.activeSession.entries = state.activeSession.entries.filter(
        (entry) => entry.exerciseId !== button.dataset.exerciseId,
      );
      await persistActiveSession();
      renderWorkout();
    });
  });

  app.querySelectorAll("[data-action='toggle-workout-entry']").forEach((button) => {
    button.addEventListener("click", async () => {
      const entry = state.activeSession.entries.find((item) => item.exerciseId === button.dataset.exerciseId);
      if (!entry) return;
      entry.collapsed = !entry.collapsed;
      await persistActiveSession();
      renderWorkout();
    });
  });

  app.querySelectorAll("[data-action='remove-set']").forEach((button) => {
    button.addEventListener("click", async () => {
      const entry = state.activeSession.entries.find((item) => item.exerciseId === button.dataset.exerciseId);
      entry.sets = entry.sets.filter((set) => set.id !== button.dataset.setId);
      if (!entry.sets.length) {
        entry.sets.push(createEmptySet());
      }
      await persistActiveSession();
      renderWorkout();
    });
  });

  app.querySelectorAll("[data-set-input]").forEach((input) => {
    input.addEventListener("input", async () => {
      const entry = state.activeSession.entries.find((item) => item.exerciseId === input.dataset.exerciseId);
      const currentSet = entry.sets.find((set) => set.id === input.dataset.setId);
      currentSet[input.dataset.field] = input.value;
      await persistActiveSession();
      updateExerciseSummary(input.dataset.exerciseId);
    });

    if (input.dataset.field === "reps") {
      input.addEventListener("change", async () => {
        const entry = state.activeSession.entries.find((item) => item.exerciseId === input.dataset.exerciseId);
        const currentIndex = entry.sets.findIndex((set) => set.id === input.dataset.setId);
        const currentSet = entry.sets[currentIndex];
        const isLastSet = currentIndex === entry.sets.length - 1;

        if (!isLastSet || !hasSetData(currentSet)) return;

        const emptySet = createEmptySet();
        entry.sets.push(emptySet);
        state.pendingFocus = {
          exerciseId: input.dataset.exerciseId,
          setId: emptySet.id,
          field: "weight",
        };
        await persistActiveSession();
        renderWorkout();
      });
    }
  });

  app.querySelectorAll("[data-action='quick-reps']").forEach((button) => {
    button.addEventListener("click", async () => {
      const entry = state.activeSession.entries.find((item) => item.exerciseId === button.dataset.exerciseId);
      const currentIndex = entry.sets.findIndex((set) => set.id === button.dataset.setId);
      const currentSet = entry.sets[currentIndex];
      currentSet.reps = button.dataset.reps;
      await persistActiveSession();
      updateExerciseSummary(button.dataset.exerciseId);

      const isLastSet = currentIndex === entry.sets.length - 1;
      if (!isLastSet || !hasSetData(currentSet)) {
        renderWorkout();
        return;
      }

      const emptySet = createEmptySet();
      entry.sets.push(emptySet);
      state.pendingFocus = {
        exerciseId: button.dataset.exerciseId,
        setId: emptySet.id,
        field: "weight",
      };
      await persistActiveSession();
      renderWorkout();
    });
  });

  applyPendingFocus();
}

function renderHistory() {
  const completed = state.sessions.filter((item) => item.status === "completed");

  app.innerHTML = `
    <section class="view">
      <section class="card stack">
        <div class="title-row">
          <h2>История тренировок</h2>
          <span class="badge">${completed.length}</span>
        </div>
        <div class="row-wrap equal-actions">
          <button class="ghost" data-action="restore-from-cloud" type="button">Восстановить из облака</button>
        </div>
        <button class="ghost full" data-action="go-home" type="button">На главный экран</button>
      </section>

      <section class="history-list">
        ${completed.map(renderHistoryCard).join("") || renderEmpty("Завершенных тренировок пока нет.")}
      </section>
    </section>
  `;

  app.querySelector('[data-action="go-home"]').addEventListener("click", () => {
    state.view = "home";
    render();
  });
  app.querySelector('[data-action="restore-from-cloud"]').addEventListener("click", handleCloudRestoreRequest);
}

function renderDayCard(day) {
  return `
    <article class="card stack">
      <div class="title-row">
        <h3>${escapeHtml(day.name)}</h3>
        <span class="badge">${day.exerciseIds.length} упражнений</span>
      </div>
      <label>
        Название дня
        <input data-day-name="${day.id}" type="text" value="${escapeHtml(day.name)}">
      </label>
      <div class="row-wrap">
        <button class="secondary" data-action="save-day" data-day-id="${day.id}" type="button">Сохранить</button>
        <button class="primary" data-action="add-exercise" data-day-id="${day.id}" type="button">Добавить упражнение</button>
        <button class="danger" data-action="delete-day" data-day-id="${day.id}" type="button">Удалить день</button>
      </div>
      <div class="exercise-list">
        ${day.exerciseIds.map((exerciseId, index) => renderDayExercise(day.id, exerciseId, index, day.exerciseIds.length)).join("") || renderEmpty("В этом дне пока нет упражнений.")}
      </div>
    </article>
  `;
}

function renderDayExercise(dayId, exerciseId, index, total) {
  const exercise = getExercise(exerciseId);
  if (!exercise) return "";

  return `
    <div class="item row-between">
      <div class="stack compact-gap">
        <strong>${escapeHtml(exercise.name)}</strong>
        <span class="muted">Позиция ${index + 1} из ${total}</span>
      </div>
      <div class="row-wrap compact-row">
        <button class="ghost square" data-action="move-exercise-up" data-day-id="${dayId}" data-exercise-id="${exerciseId}" type="button" ${index === 0 ? "disabled" : ""}>↑</button>
        <button class="ghost square" data-action="move-exercise-down" data-day-id="${dayId}" data-exercise-id="${exerciseId}" type="button" ${index === total - 1 ? "disabled" : ""}>↓</button>
        <button class="danger" data-action="remove-exercise" data-day-id="${dayId}" data-exercise-id="${exerciseId}" type="button">Убрать</button>
      </div>
    </div>
  `;
}

function renderWorkoutExercise(entry) {
  const lastHistory = findExerciseHistory(entry.exerciseId);
  const bestSet = findExerciseBest(entry.exerciseId);
  const exerciseGroup = getExercise(entry.exerciseId)?.group || "Другое";
  const isCollapsed = Boolean(entry.collapsed);
  const validSets = entry.sets.filter(hasSetData);

  return `
    <article class="card stack ${isCollapsed ? "collapsed-workout-card" : ""}">
      <div class="title-row">
        <div class="stack compact-gap">
          <h3>${escapeHtml(entry.exerciseName)}</h3>
          <span class="badge">${exerciseGroup}</span>
          <span class="muted">${renderExerciseSummary(entry)}</span>
        </div>
        <div class="row-wrap compact-row">
          <button class="ghost" data-action="toggle-workout-entry" data-exercise-id="${entry.exerciseId}" type="button">${isCollapsed ? "Развернуть" : "Свернуть"}</button>
          <button class="danger" data-action="remove-workout-exercise" data-exercise-id="${entry.exerciseId}" type="button">Удалить</button>
        </div>
      </div>
      ${isCollapsed
        ? `
          <div class="item stack compact-gap">
            <span class="muted">${validSets.length ? validSets.map((set) => `${set.weight || 0} кг x ${set.reps || 0}`).join(", ") : "Подходы пока не заполнены."}</span>
          </div>
        `
        : `
          <div class="exercise-history">
            ${
              lastHistory
                ? `
                  <p><strong>Прошлый раз:</strong> ${formatDate(lastHistory.startedAt)}</p>
                  <p class="muted">${lastHistory.sets.map((set) => `${set.weight || 0} кг x ${set.reps || 0}`).join(", ")}</p>
                `
                : '<p class="muted">Истории пока нет. Это первое выполнение упражнения.</p>'
            }
            ${bestSet ? `<p class="muted"><strong>Лучший подход:</strong> ${formatSetShort(bestSet)}</p>` : ""}
          </div>

          <div class="set-list">
            ${entry.sets.map((set, index) => renderSetRow(entry.exerciseId, set, index)).join("") || renderEmpty("Добавьте первый подход.")}
          </div>
          <button class="secondary full" data-action="add-set" data-exercise-id="${entry.exerciseId}" type="button">Добавить подход</button>
        `}
    </article>
  `;
}

function renderSetRow(exerciseId, set, index) {
  return `
    <div class="set-row">
      <div class="set-index">${index + 1}</div>
      <label>
        Вес
        <input data-set-input="1" data-field="weight" data-exercise-id="${exerciseId}" data-set-id="${set.id}" inputmode="decimal" type="number" min="0" step="0.5" value="${escapeHtml(String(set.weight ?? ""))}">
      </label>
      <label>
        Повторы
        <div class="quick-reps">
          ${[10, 12, 15].map((value) => `
            <button class="ghost quick-chip" data-action="quick-reps" data-exercise-id="${exerciseId}" data-set-id="${set.id}" data-reps="${value}" type="button">${value}</button>
          `).join("")}
        </div>
        <input data-set-input="1" data-field="reps" data-exercise-id="${exerciseId}" data-set-id="${set.id}" inputmode="numeric" type="number" min="0" step="1" value="${escapeHtml(String(set.reps ?? ""))}">
      </label>
      <button class="danger square" data-action="remove-set" data-exercise-id="${exerciseId}" data-set-id="${set.id}" type="button">X</button>
    </div>
  `;
}

function renderSessionPreview(session) {
  return `
    <div class="item stack">
      <div class="row-between">
        <strong>${escapeHtml(session.dayName || "Тренировка")}</strong>
        <span class="muted">${formatDate(session.startedAt)}</span>
      </div>
      <p class="muted">${session.entries.length} упражнений • ${formatDuration(session.durationMinutes)}</p>
    </div>
  `;
}

function renderHistoryCard(session) {
  return `
    <article class="card stack">
      <div class="title-row">
        <h3>${escapeHtml(session.dayName || "Тренировка")}</h3>
        <span class="badge">${formatDate(session.startedAt)}</span>
      </div>
      <div class="row-wrap">
        <span class="badge">Длительность: ${formatDuration(session.durationMinutes)}</span>
        <span class="badge">Упражнений: ${session.entries.length}</span>
      </div>
      <div class="stack">
        ${session.entries.map((entry) => `
          <div class="item stack">
            <strong>${escapeHtml(entry.exerciseName)}</strong>
            <span class="muted">${entry.sets.map((set) => `${set.weight || 0} кг x ${set.reps || 0}`).join(", ") || "Нет подходов"}</span>
          </div>
        `).join("")}
      </div>
    </article>
  `;
}

function renderEmpty(message) {
  return `<div class="item"><p class="muted">${message}</p></div>`;
}

function getExercise(exerciseId) {
  return state.exercises.find((exercise) => exercise.id === exerciseId);
}

function createEmptySet() {
  return { id: crypto.randomUUID(), weight: "", reps: "" };
}

function hasSetData(set) {
  return String(set.weight ?? "").trim() !== "" || String(set.reps ?? "").trim() !== "";
}

function collapseFilledWorkoutEntries(activeExerciseId = null) {
  if (!state.activeSession) return;

  state.activeSession.entries.forEach((entry) => {
    if (entry.exerciseId === activeExerciseId) {
      entry.collapsed = false;
      return;
    }

    const hasFilledSets = entry.sets.some(hasSetData);
    if (hasFilledSets) {
      entry.collapsed = true;
    }
  });
}

function applyPendingFocus() {
  if (!state.pendingFocus) return;

  const { exerciseId, setId, field } = state.pendingFocus;
  requestAnimationFrame(() => {
    const selector = `[data-set-input="1"][data-exercise-id="${exerciseId}"][data-set-id="${setId}"][data-field="${field}"]`;
    const input = document.querySelector(selector);
    if (input) {
      input.focus();
      input.select?.();
      state.pendingFocus = null;
    }
  });
}

async function startWorkout() {
  if (state.activeSession) {
    state.view = "workout";
    render();
    return;
  }

  state.activeSession = {
    id: crypto.randomUUID(),
    dayId: null,
    dayName: "Тренировка",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "active",
    entries: [],
  };

  await persistActiveSession();
  state.view = "workout";
  render();
}

async function persistActiveSession() {
  if (!state.activeSession) return;
  await put("sessions", state.activeSession);
  await refreshState(false);
}

async function finishWorkout() {
  state.activeSession.entries = state.activeSession.entries
    .map((entry) => ({
      ...entry,
      sets: entry.sets.filter(hasSetData),
    }))
    .filter((entry) => entry.sets.length > 0);

  const hasExercises = state.activeSession.entries.length > 0;

  if (!hasExercises) {
    await del("sessions", state.activeSession.id);
    state.activeSession = null;
    await refreshState(false);
    state.view = "home";
    render();
    return;
  }

  const finishedAt = new Date().toISOString();
  const durationMinutes = Math.max(
    1,
    Math.round((new Date(finishedAt).getTime() - new Date(state.activeSession.startedAt).getTime()) / 60000),
  );

  state.activeSession.status = "completed";
  state.activeSession.finishedAt = finishedAt;
  state.activeSession.durationMinutes = durationMinutes;
  await put("sessions", state.activeSession);
  state.activeSession = null;
  await refreshState(false);
  state.view = "history";
  render();
  await handlePostWorkoutSync();
}

async function cancelWorkout() {
  if (!state.activeSession) return;
  const confirmed = confirm("Удалить текущую активную тренировку?");
  if (!confirmed) return;
  await del("sessions", state.activeSession.id);
  state.activeSession = null;
  await refreshState(false);
  state.view = "home";
  render();
}

function findExerciseHistory(exerciseId) {
  const completed = state.sessions.filter((session) => session.status === "completed");
  for (const session of completed) {
    const entry = session.entries.find((item) => item.exerciseId === exerciseId && item.sets.length > 0);
    if (entry) {
      return {
        startedAt: session.startedAt,
        sets: entry.sets,
      };
    }
  }
  return null;
}

function renderExerciseSummary(entry) {
  const validSets = entry.sets.filter(hasSetData);
  const volume = validSets.reduce((sum, set) => {
    return sum + Number(set.weight || 0) * Number(set.reps || 0);
  }, 0);

  return `${validSets.length} подходов · тоннаж ${volume}`;
}

function updateExerciseSummary(exerciseId) {
  const entry = state.activeSession?.entries.find((item) => item.exerciseId === exerciseId);
  const target = document.querySelector(`#summary-${CSS.escape(exerciseId)}`);
  if (entry && target) {
    target.innerHTML = renderExerciseSummary(entry);
  }
}

function findExerciseBest(exerciseId) {
  const completed = state.sessions.filter((session) => session.status === "completed");
  let best = null;

  completed.forEach((session) => {
    session.entries.forEach((entry) => {
      if (entry.exerciseId !== exerciseId) return;
      entry.sets.forEach((set) => {
        const weight = Number(set.weight || 0);
        const reps = Number(set.reps || 0);
        if (!best) {
          best = set;
          return;
        }

        const bestWeight = Number(best.weight || 0);
        const bestReps = Number(best.reps || 0);
        if (weight > bestWeight || (weight === bestWeight && reps > bestReps)) {
          best = set;
        }
      });
    });
  });

  return best;
}

async function createExercise(name, group = "Другое") {
  const normalized = name.trim();
  if (!normalized) return null;

  let exercise = state.exercises.find((item) => item.name.toLowerCase() === normalized.toLowerCase());
  if (exercise) return exercise;

  exercise = {
    id: crypto.randomUUID(),
    name: normalized,
    group,
    createdAt: new Date().toISOString(),
  };
  await put("exercises", exercise);
  return exercise;
}

async function attachExerciseToWorkout(exerciseId) {
  if (!state.activeSession) return;
  const exists = state.activeSession.entries.some((entry) => entry.exerciseId === exerciseId);
  if (exists) return;
  collapseFilledWorkoutEntries(exerciseId);
  const firstSet = createEmptySet();
  state.activeSession.entries.push({
    exerciseId,
    exerciseName: getExercise(exerciseId)?.name ?? "Упражнение",
    sets: [firstSet],
    collapsed: false,
  });
  state.pendingFocus = {
    exerciseId,
    setId: firstSet.id,
    field: "weight",
  };
  await persistActiveSession();
}

async function exportBackup() {
  const blob = buildBackupBlob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = getYandexDiskFileName();
  link.click();
  URL.revokeObjectURL(url);
}

function openYandexDiskModal() {
  state.modal = { type: "yandex-disk" };
  renderModal();
  if (isYandexDiskConnected()) {
    loadYandexBackups()
      .then(() => {
        if (state.modal?.type === "yandex-disk") renderModal();
      })
      .catch((error) => {
        console.warn("Не удалось обновить список резервных копий", error);
      });
  }
}

async function saveYandexDiskSettingsFromModal() {
  await saveYandexDiskConfig({
    clientId: YANDEX_CLIENT_ID,
    folder: DEFAULT_YANDEX_BACKUP_FOLDER,
  });
}

async function connectYandexDisk() {
  await saveYandexDiskSettingsFromModal();
  if (!state.yandexDisk.clientId) {
    alert("Не найден идентификатор приложения Яндекса.");
    return;
  }

  const authUrl = new URL(YANDEX_OAUTH_URL);
  authUrl.searchParams.set("response_type", "token");
  authUrl.searchParams.set("client_id", state.yandexDisk.clientId);
  authUrl.searchParams.set("redirect_uri", getYandexRedirectUri());
  window.location.href = authUrl.toString();
}

async function disconnectYandexDisk() {
  await saveYandexDiskConfig({
    accessToken: "",
    connectedAt: "",
    expiresAt: "",
    lastSyncAt: "",
  });
  state.yandexBackups = [];
  renderModal();
}

async function syncBackupToYandexDisk() {
  try {
    const fileName = await uploadBackupToYandexDisk();
    await loadYandexBackups();
    renderModal();
    alert(`Резервная копия загружена в Яндекс Диск: ${fileName}`);
  } catch (error) {
    alert(error instanceof Error ? error.message : "Не удалось загрузить резервную копию в Яндекс Диск.");
  }
}

async function handlePostWorkoutSync() {
  if (isYandexDiskConnected()) {
    try {
      await uploadBackupToYandexDisk();
      await loadYandexBackups();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Не удалось сохранить резервную копию в Яндекс Диск.";
      await saveYandexDiskConfig({ lastSyncError: message });
      console.warn("Silent Yandex Disk sync failed", error);
    }
    return;
  }

  if (state.yandexDisk.authPromptShown) return;

  await saveYandexDiskConfig({ authPromptShown: true });
  state.modal = { type: "yandex-connect-once" };
  renderModal();
}

async function handleCloudRestoreRequest() {
  if (isYandexDiskConnected()) {
    openYandexDiskModal();
    return;
  }

  if (!state.yandexDisk.authPromptShown) {
    await saveYandexDiskConfig({ authPromptShown: true });
    state.modal = { type: "yandex-connect-once" };
    renderModal();
    return;
  }

  openYandexDiskModal();
}

async function refreshYandexBackups() {
  try {
    await saveYandexDiskSettingsFromModal();
    await pruneYandexBackups();
    renderModal();
  } catch (error) {
    alert(error instanceof Error ? error.message : "Не удалось получить список резервных копий.");
  }
}

async function restoreYandexBackup(path) {
  state.modal = { type: "restore-import-guide", remotePath: path };
  renderModal();
}

function downloadLibraryTemplate() {
  const template = [
    "[Грудь]",
    "Жим лежа",
    "Жим гантелей под углом",
    "",
    "[Спина]",
    "Подтягивания",
    "Тяга штанги в наклоне",
    "",
    "[Ноги]",
    "Присед",
    "Жим ногами",
    "",
    "[Другое]",
    "Планка",
  ].join("\r\n");

  const blob = new Blob([template], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "exercise-library-template.txt";
  link.click();
  URL.revokeObjectURL(url);
}

async function importBackup(event) {
  const [file] = event.target.files;
  if (!file) return;

  try {
    const data = JSON.parse(await file.text());
    if (!confirm("Импорт заменит текущие локальные данные. Продолжить?")) {
      event.target.value = "";
      return;
    }

    await applyImportedBackup(data);
    event.target.value = "";
    alert("Импорт завершен.");
  } catch (error) {
    event.target.value = "";
    alert(error instanceof Error ? error.message : "Не удалось импортировать файл.");
  }
}

async function importExerciseLibraryFromTxt(event) {
  const [file] = event.target.files;
  if (!file) return;

  try {
    const text = await file.text();
    const lines = text.split(/\r?\n/).map((line) => line.trim());
    let currentGroup = "Другое";
    const parsedExercises = [];

    lines.forEach((line) => {
      if (!line) return;

      const groupMatch = line.match(/^\[(.+)\]$/);
      if (groupMatch) {
        const candidate = groupMatch[1].trim();
        currentGroup = EXERCISE_GROUPS.includes(candidate) ? candidate : "Другое";
        return;
      }

      parsedExercises.push({
        name: line,
        group: currentGroup,
      });
    });

    if (!parsedExercises.length) {
      throw new Error("В текстовом файле не найдено ни одного упражнения.");
    }

    let addedCount = 0;
    let updatedCount = 0;
    for (const item of parsedExercises) {
      const existing = state.exercises.find((exercise) => exercise.name.toLowerCase() === item.name.toLowerCase());
      if (existing) {
        if ((existing.group || "Другое") !== item.group) {
          await put("exercises", { ...existing, group: item.group });
          updatedCount += 1;
        }
        continue;
      }
      await createExercise(item.name, item.group);
      addedCount += 1;
    }

    event.target.value = "";
    await refreshState();
    if (addedCount || updatedCount) {
      alert(`Добавлено: ${addedCount}. Обновлено групп: ${updatedCount}.`);
    } else {
      alert("Все упражнения из файла уже были в справочнике с теми же группами.");
    }
  } catch (error) {
    event.target.value = "";
    alert(error instanceof Error ? error.message : "Не удалось загрузить текстовый файл.");
  }
}

function renderModal() {
  if (!state.modal) {
    document.body.classList.remove("modal-open");
    modalRoot.innerHTML = "";
    return;
  }

  document.body.classList.add("modal-open");

  const filterGroup = state.modal?.groupFilter || "Все";
  const searchQuery = (state.modal?.searchQuery || "").trim().toLowerCase();
  const exerciseUsage = new Map();
  state.sessions.forEach((session) => {
    session.entries.forEach((entry) => {
      exerciseUsage.set(entry.exerciseId, (exerciseUsage.get(entry.exerciseId) || 0) + 1);
    });
  });
  const renderGroupFilters = (modalType) => `
    <div class="filter-chips">
      ${["Все", ...EXERCISE_GROUPS].map((group) => `
        <button
          class="filter-chip ${filterGroup === group ? "active" : ""}"
          data-action="set-group-filter"
          data-modal-type="${modalType}"
          data-group="${group}"
          type="button"
        >${group}</button>
      `).join("")}
    </div>
  `;
  const groupedExercises = EXERCISE_GROUPS.map((group) => ({
    group,
    items: state.exercises.filter((exercise) => {
      const matchesGroup = (exercise.group || "Другое") === group;
      const matchesSearch = !searchQuery || exercise.name.toLowerCase().includes(searchQuery);
      return matchesGroup && matchesSearch;
    }).sort((a, b) => {
      const usageDiff = (exerciseUsage.get(b.id) || 0) - (exerciseUsage.get(a.id) || 0);
      if (usageDiff !== 0) return usageDiff;
      return a.name.localeCompare(b.name, "ru");
    }),
  }))
    .filter((section) => (filterGroup === "Все" ? section.items.length > 0 : section.group === filterGroup));

  if (state.modal.type === "exercise-library") {
    modalRoot.innerHTML = `
      <div class="modal-backdrop" data-action="close-backdrop">
        <section class="modal-card">
          <div class="title-row">
            <h3>Справочник упражнений</h3>
            <button class="ghost square" data-action="close-modal" type="button">X</button>
          </div>
          <form id="libraryForm" class="stack">
            <label>
              Новое упражнение
              <input id="libraryExerciseName" type="text" placeholder="Например, румынская тяга">
            </label>
            <label>
              Группа
              <select id="libraryExerciseGroup">
                ${EXERCISE_GROUPS.map((group) => `<option value="${group}">${group}</option>`).join("")}
              </select>
            </label>
            <button class="primary full" type="submit">Сохранить</button>
          </form>
          <div class="item stack compact-gap">
            <strong>Импорт из текстового файла</strong>
            <code>[Грудь] / [Спина] / [Ноги] / [Другое]</code>
            <button class="ghost" data-action="open-library-txt-import" type="button">Выбрать файл</button>
          </div>
          <label>
            Поиск упражнения
            <input id="librarySearchQuery" type="text" value="${escapeHtml(state.modal?.searchQuery || "")}" placeholder="Начните вводить название">
          </label>
          ${renderGroupFilters("exercise-library")}
          <div class="exercise-picker">
            ${groupedExercises.length
              ? groupedExercises.map((section) => `
                  <div class="stack compact-gap">
                    <span class="badge">${section.group}</span>
                    ${section.items.map((exercise) => `
                      <div class="item row-between">
                        <span>${escapeHtml(exercise.name)}</span>
                        <button class="danger" data-action="delete-exercise" data-exercise-id="${exercise.id}" type="button">Удалить</button>
                      </div>
                    `).join("")}
                  </div>
                `).join("")
              : '<div class="item">Справочник пуст</div>'
            }
          </div>
        </section>
      </div>
    `;

    modalRoot.querySelector('[data-action="close-modal"]').addEventListener("click", closeModal);
    modalRoot.querySelector('[data-action="close-backdrop"]').addEventListener("click", (event) => {
      if (event.target === event.currentTarget) closeModal();
    });
    modalRoot.querySelector("#libraryForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = modalRoot.querySelector("#libraryExerciseName").value.trim();
      const group = modalRoot.querySelector("#libraryExerciseGroup").value;
      if (!name) return;
      await createExercise(name, group);
      closeModal();
      await refreshState();
    });
    modalRoot.querySelectorAll('[data-action="delete-exercise"]').forEach((button) => {
      button.addEventListener("click", async () => {
        const exerciseId = button.dataset.exerciseId;
        const used = state.sessions.some((session) =>
          session.entries.some((entry) => entry.exerciseId === exerciseId),
        );
        if (used) {
          alert("Нельзя удалить упражнение, которое уже используется в истории тренировок.");
          return;
        }
        await del("exercises", exerciseId);
        await refreshState();
        state.modal = {
          type: "exercise-library",
          groupFilter: filterGroup,
          searchQuery: state.modal?.searchQuery || "",
        };
        renderModal();
      });
    });
    modalRoot.querySelector('[data-action="open-library-txt-import"]').addEventListener("click", () => {
      closeModal();
      importTxtInput.click();
    });
    modalRoot.querySelector('#librarySearchQuery').addEventListener("input", (event) => {
      state.modal = {
        type: "exercise-library",
        groupFilter: filterGroup,
        searchQuery: event.target.value,
      };
      renderModal();
    });
  }

  if (state.modal.type === "workout-exercise-picker") {
    modalRoot.innerHTML = `
      <div class="modal-backdrop" data-action="close-backdrop">
        <section class="modal-card">
          <div class="title-row">
            <h3>Добавить упражнение в тренировку</h3>
            <button class="ghost square" data-action="close-modal" type="button">X</button>
          </div>
          <label>
            Поиск упражнения
            <input id="workoutSearchQuery" type="text" value="${escapeHtml(state.modal?.searchQuery || "")}" placeholder="Начните вводить название">
          </label>
          ${renderGroupFilters("workout-exercise-picker")}
          <div class="exercise-picker">
            ${groupedExercises.length
              ? groupedExercises.map((section) => `
                  <div class="stack compact-gap">
                    <span class="badge">${section.group}</span>
                    ${section.items.map((exercise) => `
                      <button class="item picker-btn" data-action="pick-workout-exercise" data-exercise-id="${exercise.id}" type="button">
                        ${escapeHtml(exercise.name)}
                      </button>
                    `).join("")}
                  </div>
                `).join("")
              : '<div class="item">Справочник пуст</div>'
            }
          </div>
          <form id="workoutExerciseForm" class="stack">
            <label>
              Новое упражнение
              <input id="workoutExerciseName" type="text" placeholder="Например, жим лежа">
            </label>
            <label>
              Группа
              <select id="workoutExerciseGroup">
                ${EXERCISE_GROUPS.map((group) => `<option value="${group}">${group}</option>`).join("")}
              </select>
            </label>
            <button class="primary full" type="submit">Создать и добавить</button>
          </form>
        </section>
      </div>
    `;

    modalRoot.querySelector('[data-action="close-modal"]').addEventListener("click", closeModal);
    modalRoot.querySelector('[data-action="close-backdrop"]').addEventListener("click", (event) => {
      if (event.target === event.currentTarget) closeModal();
    });
    modalRoot.querySelector("#workoutExerciseForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = modalRoot.querySelector("#workoutExerciseName").value.trim();
      const group = modalRoot.querySelector("#workoutExerciseGroup").value;
      if (!name) return;
      const exercise = await createExercise(name, group);
      await attachExerciseToWorkout(exercise.id);
      closeModal();
      renderWorkout();
    });
    modalRoot.querySelector('#workoutSearchQuery').addEventListener("input", (event) => {
      state.modal = {
        type: "workout-exercise-picker",
        groupFilter: filterGroup,
        searchQuery: event.target.value,
      };
      renderModal();
    });
    modalRoot.querySelectorAll('[data-action="pick-workout-exercise"]').forEach((button) => {
      button.addEventListener("click", async () => {
        await attachExerciseToWorkout(button.dataset.exerciseId);
        closeModal();
        renderWorkout();
      });
    });
  }

  if (state.modal.type === "yandex-disk") {
    const isConnected = isYandexDiskConnected();
    const backupsMarkup = state.yandexBackups.length
      ? state.yandexBackups.map((item) => `
          <div class="item stack compact-gap">
            <div class="row-between">
              <strong>${escapeHtml(item.name)}</strong>
              <span class="muted">${formatDate(item.modified || item.created)}</span>
            </div>
            <div class="row-between">
              <span class="muted">${formatBytes(item.size || 0)}</span>
              <button class="ghost" data-action="restore-yandex-backup" data-path="${escapeHtml(item.path)}" type="button">Восстановить</button>
            </div>
          </div>
        `).join("")
      : '<div class="item"><p class="muted">Облачные резервные копии пока не загружались.</p></div>';

    modalRoot.innerHTML = `
      <div class="modal-backdrop" data-action="close-backdrop">
        <section class="modal-card">
          <div class="title-row">
            <h3>${isConnected ? "Восстановить из облака" : "Подключить Яндекс Диск"}</h3>
            <button class="ghost square" data-action="close-modal" type="button">X</button>
          </div>
          ${isConnected
            ? `
              <div class="stack">
                ${state.yandexDisk.lastSyncError
                  ? `<div class="item"><p class="muted">Последняя синхронизация не выполнена: ${escapeHtml(state.yandexDisk.lastSyncError)}</p></div>`
                  : ""}
                <div class="item"><p class="muted">Нажмите «Восстановить», после чего откроется пошаговое окно: сначала скачайте резервную копию, затем выберите скачанный файл для загрузки в приложение.</p></div>
                ${backupsMarkup}
              </div>
              <div class="row-wrap equal-actions">
                <button class="ghost" data-action="refresh-yandex-backups" type="button">Обновить список</button>
                <button class="danger" data-action="disconnect-yandex-disk" type="button">Отключить Яндекс Диск</button>
              </div>
            `
            : `
              <p class="muted">Подключите Яндекс Диск, чтобы приложение автоматически сохраняло резервные копии в облако и позволяло восстановить данные при необходимости.</p>
              <div class="row-wrap equal-actions">
                <button class="primary" data-action="connect-yandex-disk" type="button">Подключить</button>
                <button class="ghost" data-action="close-modal" type="button">Позже</button>
              </div>
            `}
        </section>
      </div>
    `;

    modalRoot.querySelectorAll('[data-action="close-modal"]').forEach((button) => {
      button.addEventListener("click", closeModal);
    });
    modalRoot.querySelector('[data-action="close-backdrop"]').addEventListener("click", (event) => {
      if (event.target === event.currentTarget) closeModal();
    });
    modalRoot.querySelector('[data-action="connect-yandex-disk"]')?.addEventListener("click", connectYandexDisk);
    modalRoot.querySelector('[data-action="refresh-yandex-backups"]')?.addEventListener("click", refreshYandexBackups);
    modalRoot.querySelector('[data-action="disconnect-yandex-disk"]')?.addEventListener("click", disconnectYandexDisk);
    modalRoot.querySelectorAll('[data-action="restore-yandex-backup"]').forEach((button) => {
      button.addEventListener("click", () => restoreYandexBackup(button.dataset.path));
    });
  }

  if (state.modal.type === "yandex-connect-once") {
    modalRoot.innerHTML = `
      <div class="modal-backdrop" data-action="close-backdrop">
        <section class="modal-card">
          <div class="title-row">
            <h3>Подключить Яндекс Диск?</h3>
            <button class="ghost square" data-action="close-modal" type="button">X</button>
          </div>
          <p class="muted">После подключения приложение будет автоматически загружать резервные копии в облако после завершения тренировки, а при необходимости вы сможете восстановить данные из облака. Это окно показывается только один раз.</p>
          <div class="row-wrap equal-actions">
            <button class="primary" data-action="connect-yandex-disk" type="button">Подключить</button>
            <button class="ghost" data-action="close-modal" type="button">Позже</button>
          </div>
        </section>
      </div>
    `;

    modalRoot.querySelectorAll('[data-action="close-modal"]').forEach((button) => {
      button.addEventListener("click", closeModal);
    });
    modalRoot.querySelector('[data-action="close-backdrop"]').addEventListener("click", (event) => {
      if (event.target === event.currentTarget) closeModal();
    });
    modalRoot.querySelector('[data-action="connect-yandex-disk"]').addEventListener("click", connectYandexDisk);
  }

  if (state.modal.type === "install-help") {
    modalRoot.innerHTML = `
      <div class="modal-backdrop" data-action="close-backdrop">
        <section class="modal-card">
          <div class="title-row">
            <h3>Установка на iPhone</h3>
            <button class="ghost square" data-action="close-modal" type="button">X</button>
          </div>
          <div class="item stack compact-gap">
            <span class="muted">1. Нажмите кнопку «Поделиться» в Safari.</span>
            <span class="muted">2. Выберите «На экран Домой».</span>
            <span class="muted">3. Подтвердите добавление приложения.</span>
          </div>
          <button class="primary full" data-action="close-modal" type="button">Понятно</button>
        </section>
      </div>
    `;

    modalRoot.querySelectorAll('[data-action="close-modal"]').forEach((button) => {
      button.addEventListener("click", closeModal);
    });
    modalRoot.querySelector('[data-action="close-backdrop"]').addEventListener("click", (event) => {
      if (event.target === event.currentTarget) closeModal();
    });
  }

  if (state.modal.type === "restore-import-guide") {
    const remotePath = state.modal.remotePath;
    const showIosDownloadHint = isIosSafari();
    modalRoot.innerHTML = `
      <div class="modal-backdrop" data-action="close-backdrop">
        <section class="modal-card">
          <div class="title-row">
            <h3>Завершите восстановление</h3>
            <button class="ghost square" data-action="close-modal" type="button">X</button>
          </div>
          <div class="item stack compact-gap">
            <strong>Что делать дальше</strong>
            <span class="muted">1. Нажмите «Скачать копию».</span>
            ${showIosDownloadHint
              ? '<span class="muted">2. На iPhone файл откроется в Safari. Нажмите «Поделиться» и сохраните его в «Файлы».</span>'
              : '<span class="muted">2. Дождитесь, пока браузер скачает резервную копию.</span>'}
            <span class="muted">3. Нажмите «Выбрать скачанный файл» и укажите этот JSON-файл.</span>
          </div>
          <div class="row-wrap equal-actions">
            <button class="secondary" data-action="download-cloud-backup" type="button">Скачать копию</button>
            <button class="primary" data-action="pick-import-backup" type="button">Выбрать скачанный файл</button>
            <button class="ghost" data-action="close-modal" type="button">Позже</button>
          </div>
        </section>
      </div>
    `;

    modalRoot.querySelectorAll('[data-action="close-modal"]').forEach((button) => {
      button.addEventListener("click", closeModal);
    });
    modalRoot.querySelector('[data-action="close-backdrop"]').addEventListener("click", (event) => {
      if (event.target === event.currentTarget) closeModal();
    });
    modalRoot.querySelector('[data-action="download-cloud-backup"]').addEventListener("click", async () => {
      const downloadWindow = window.open("", "_blank");
      try {
        await restoreBackupFromYandexDisk(remotePath, downloadWindow);
      } catch (error) {
        if (downloadWindow && !downloadWindow.closed) {
          downloadWindow.close();
        }
        alert(error instanceof Error ? error.message : "Не удалось скачать резервную копию.");
      }
    });
    modalRoot.querySelector('[data-action="pick-import-backup"]').addEventListener("click", () => {
      closeModal();
      importInput.click();
    });
  }

  modalRoot.querySelectorAll('[data-action="set-group-filter"]').forEach((button) => {
    button.addEventListener("click", () => {
      state.modal = {
        type: button.dataset.modalType,
        groupFilter: button.dataset.group,
        searchQuery: state.modal?.searchQuery || "",
      };
      renderModal();
    });
  });

}

function closeModal() {
  state.modal = null;
  renderModal();
}

async function refreshState(renderAfter = true) {
  await loadState();
  if (renderAfter) render();
}

function formatDate(value) {
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: APP_TIME_ZONE,
  }).format(new Date(value));
}

function getDateTimeParts(value) {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(value);

  const map = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: map.hour,
    minute: map.minute,
    second: map.second,
  };
}

function shouldShowIosInstallHelp() {
  if (isNativeApp()) return false;
  const ua = navigator.userAgent || "";
  const isIos = /iPhone|iPad|iPod/i.test(ua);
  const isSafari = /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS|YaBrowser/i.test(ua);
  return Boolean(isIos && isSafari && !isStandaloneApp());
}

function isStandaloneApp() {
  return Boolean(isNativeApp() || window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator.standalone);
}

function isNativeApp() {
  return Boolean(
    window.Capacitor?.isNativePlatform?.() ||
    window.location.protocol === "capacitor:" ||
    window.location.protocol === "file:",
  );
}

function isIosSafari() {
  const ua = navigator.userAgent || "";
  const isIos = /iPhone|iPad|iPod/i.test(ua);
  const isSafari = /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS|YaBrowser/i.test(ua);
  return Boolean(isIos && isSafari);
}

function formatDuration(minutes) {
  const totalMinutes = Number(minutes || 0);
  if (!totalMinutes) return "0 мин";
  const hours = Math.floor(totalMinutes / 60);
  const restMinutes = totalMinutes % 60;
  if (!hours) return `${restMinutes} мин`;
  if (!restMinutes) return `${hours} ч`;
  return `${hours} ч ${restMinutes} мин`;
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return "0 Б";
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

function formatSetShort(set) {
  return `${Number(set.weight || 0)} кг x ${Number(set.reps || 0)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function registerServiceWorker() {
  if (isNativeApp()) return;
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("./sw.js");
  } catch (error) {
    console.error("Service worker registration failed", error);
  }
}
