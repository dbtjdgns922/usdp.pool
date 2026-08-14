const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 3000;

// =====================================================
// CoinGecko 설정
// =====================================================

const COINGECKO_API_KEY =
  process.env.COINGECKO_API_KEY || "";

const CATEGORY_ID = "pools-launchpad";

const API_URL =
  "https://api.coingecko.com/api/v3/coins/categories";

// =====================================================
// 캐시 설정
// =====================================================

// 5분
const CACHE_DURATION = 5 * 60 * 1000;

// API 오류/429 발생 후 재시도하기 전 최소 대기시간
// CoinGecko Rate Limit 보호를 위해 최소 5분 대기
const RETRY_AFTER_ERROR = 5 * 60 * 1000;

// =====================================================
// 파일
// =====================================================

const CACHE_FILE =
  path.join(__dirname, "cache.json");

const HISTORY_FILE =
  path.join(__dirname, "history.json");

// =====================================================
// Express
// =====================================================

app.use(express.json());

app.use(express.static(__dirname));

// =====================================================
// 메모리 캐시
// =====================================================

let latestData = null;

let lastSuccessfulUpdate = 0;

let lastUpdateAttempt = 0;

let lastError = null;

let isUpdating = false;

// =====================================================
// 파일 읽기
// =====================================================

function readJsonFile(file) {

  try {

    if (!fs.existsSync(file)) {
      return null;
    }

    const content =
      fs.readFileSync(
        file,
        "utf8"
      );

    if (!content.trim()) {
      return null;
    }

    return JSON.parse(content);

  } catch (error) {

    console.error(
      `JSON 파일 읽기 오류 (${file}):`,
      error.message
    );

    return null;
  }
}

// =====================================================
// JSON 파일 저장
// =====================================================

function writeJsonFile(file, data) {

  try {

    fs.writeFileSync(
      file,
      JSON.stringify(
        data,
        null,
        2
      ),
      "utf8"
    );

    return true;

  } catch (error) {

    console.error(
      `JSON 파일 저장 오류 (${file}):`,
      error.message
    );

    return false;
  }
}

// =====================================================
// 숫자 처리
// =====================================================

function safeNumber(value) {

  const number =
    Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  return number;
}

// =====================================================
// 캐시 불러오기
// =====================================================

function loadCache() {

  const cache =
    readJsonFile(CACHE_FILE);

  if (!cache) {
    return;
  }

  if (
    cache.data &&
    typeof cache.data === "object"
  ) {

    latestData =
      cache.data;

    lastSuccessfulUpdate =
      Number(
        cache.savedAt ||
        cache.data.timestamp ||
        0
      );

    console.log(
      "기존 캐시 데이터를 불러왔습니다."
    );

  }

}

// =====================================================
// 캐시 저장
// =====================================================

function saveCache(data) {

  const cache = {

    savedAt:
      Date.now(),

    data:
      data

  };

  writeJsonFile(
    CACHE_FILE,
    cache
  );
}

// =====================================================
// History 불러오기
// =====================================================

function loadHistory() {

  const history =
    readJsonFile(HISTORY_FILE);

  if (!Array.isArray(history)) {
    return [];
  }

  return history;
}

// =====================================================
// History 저장
// =====================================================

function saveHistory(history) {

  writeJsonFile(
    HISTORY_FILE,
    history
  );
}

// =====================================================
// History 추가
// =====================================================

function addHistory(data) {

  let history =
    loadHistory();

  history.push(data);

  // 최근 90일만 보관

  const ninetyDaysAgo =
    Date.now() -
    90 *
    24 *
    60 *
    60 *
    1000;

  history =
    history.filter(
      item =>
        Number(item.timestamp) >=
        ninetyDaysAgo
    );

  saveHistory(history);
}

// =====================================================
// CoinGecko API 호출
// =====================================================

async function fetchCategory() {

  const headers = {

    accept:
      "application/json"

  };

  // API Key

  if (COINGECKO_API_KEY) {

    headers[
      "x-cg-demo-api-key"
    ] =
      COINGECKO_API_KEY;

  }

  console.log(
    "CoinGecko API 요청..."
  );

  const response =
    await fetch(
      API_URL,
      {
        method: "GET",
        headers
      }
    );

  // =================================================
  // Rate Limit
  // =================================================

  if (
    response.status === 429
  ) {

    const text =
      await response.text();

    const error =
      new Error(
        `CoinGecko API Rate Limit (429): ${text}`
      );

    error.code = 429;

    const retryAfter =
      response.headers.get("retry-after");

    if (retryAfter) {
      error.retryAfter = retryAfter;
    }

    throw error;
  }

  // =================================================
  // 기타 HTTP 오류
  // =================================================

  if (!response.ok) {

    const text =
      await response.text();

    const error =
      new Error(
        `CoinGecko API 오류 ${response.status}: ${text}`
      );

    error.code =
      response.status;

    throw error;
  }

  // =================================================
  // JSON
  // =================================================

  const categories =
    await response.json();

  if (!Array.isArray(categories)) {

    throw new Error(
      "CoinGecko 응답 형식이 올바르지 않습니다."
    );
  }

  // =================================================
  // Pools / Launchpad 찾기
  // =================================================

  const category =
    categories.find(
      item =>
        item.id === CATEGORY_ID
    );

  if (!category) {

    throw new Error(
      `카테고리 '${CATEGORY_ID}'를 찾을 수 없습니다.`
    );
  }

  // =================================================
  // 데이터 반환
  // =================================================

  return {

    timestamp:
      Date.now(),

    date:
      new Date().toISOString(),

    categoryId:
      category.id,

    categoryName:
      category.name,

    marketCap:
      safeNumber(
        category.market_cap
      ),

    volume24h:
      safeNumber(
        category.volume_24h
      ),

    marketCapChange24h:
      safeNumber(
        category.market_cap_change_24h
      ),

    updatedAt:
      category.updated_at || null

  };

}

// =====================================================
// 데이터 업데이트
// =====================================================

async function updateData(
  force = false
) {

  // 이미 업데이트 중이면 중복 요청 방지

  if (isUpdating) {

    console.log(
      "이미 데이터 업데이트가 진행 중입니다."
    );

    return latestData;
  }

  const now =
    Date.now();

  // =================================================
  // 캐시가 아직 유효하면 API 요청하지 않음
  // =================================================

  if (
    !force &&
    latestData &&
    lastSuccessfulUpdate > 0 &&
    now -
      lastSuccessfulUpdate <
      CACHE_DURATION
  ) {

    console.log(
      "캐시가 유효합니다. CoinGecko 요청을 건너뜁니다."
    );

    return latestData;
  }

  // =================================================
  // 이전 실패 후 너무 빨리 재시도하지 않음
  // =================================================

  if (
    !force &&
    lastUpdateAttempt > 0 &&
    now -
      lastUpdateAttempt <
      RETRY_AFTER_ERROR &&
    lastError
  ) {

    console.log(
      "최근 API 오류가 발생했습니다. 재시도를 건너뜁니다."
    );

    return latestData;
  }

  isUpdating = true;

  lastUpdateAttempt =
    now;

  try {

    console.log(
      "=========================================="
    );

    console.log(
      "CoinGecko 데이터 업데이트 시작"
    );

    console.log(
      new Date().toISOString()
    );

    console.log(
      "=========================================="
    );

    // API 요청

    const data =
      await fetchCategory();

    // =================================================
    // 성공
    // =================================================

    latestData =
      data;

    lastSuccessfulUpdate =
      Date.now();

    lastError =
      null;

    // 캐시 저장

    saveCache(data);

    // History 저장

    addHistory(data);

    console.log(
      "CoinGecko 업데이트 성공"
    );

    console.log({

      marketCap:
        data.marketCap,

      volume24h:
        data.volume24h

    });

    return data;

  } catch (error) {

    lastError =
      error.message;

    // =================================================
    // 중요:
    // 이전 데이터가 있다면 그대로 유지
    // =================================================

    if (latestData) {

      console.warn(
        "CoinGecko 업데이트 실패."
      );

      console.warn(
        "마지막 정상 데이터를 유지합니다."
      );

      console.warn(
        error.message
      );

      if (error.code === 429 && error.retryAfter) {

        console.warn(
          `CoinGecko Retry-After: ${error.retryAfter}`
        );

      }

      return latestData;

    }

    // =================================================
    // 이전 데이터도 없는 경우
    // =================================================

    console.error(
      "CoinGecko 데이터 업데이트 실패:"
    );

    console.error(
      error.message
    );

    return null;

  } finally {

    isUpdating =
      false;

  }
}

// =====================================================
// 서버 시작 시 캐시 불러오기
// =====================================================

loadCache();

// =====================================================
// 처음 데이터 업데이트
// =====================================================

setTimeout(
  async () => {

    try {

      await updateData();

    } catch (error) {

      console.error(
        "초기 업데이트 오류:",
        error.message
      );

    }

  },
  1000
);

// =====================================================
// 5분마다 업데이트
// =====================================================

setInterval(
  async () => {

    try {

      await updateData();

    } catch (error) {

      console.error(
        "자동 업데이트 오류:",
        error.message
      );

    }

  },
  CACHE_DURATION
);

// =====================================================
// 현재 데이터 API
// =====================================================

app.get(
  "/api/current",
  async (req, res) => {

    try {

      // 캐시가 없으면 데이터 요청

      if (!latestData) {

        await updateData();

      }

      // =================================================
      // 여전히 데이터가 없다면 오류
      // =================================================

      if (!latestData) {

        return res.status(503).json({

          success:
            false,

          data:
            null,

          error:
            lastError ||
            "Market data is temporarily unavailable.",

          cached:
            false

        });

      }

      // =================================================
      // 정상 응답
      // =================================================

      const age =
        Date.now() -
        lastSuccessfulUpdate;

      const cached =
        age >
        CACHE_DURATION;

      res.json({

        success:
          true,

        data:
          latestData,

        cached:
          cached,

        cacheAgeSeconds:
          Math.floor(
            age / 1000
          ),

        lastSuccessfulUpdate:
          lastSuccessfulUpdate,

        lastError:
          lastError

      });

    } catch (error) {

      console.error(
        "/api/current 오류:",
        error.message
      );

      // =================================================
      // 마지막 데이터가 있으면 그것을 반환
      // =================================================

      if (latestData) {

        return res.json({

          success:
            true,

          data:
            latestData,

          cached:
            true,

          stale:
            true,

          lastError:
            error.message

        });

      }

      // =================================================
      // 데이터가 전혀 없으면 503
      // =================================================

      res.status(503).json({

        success:
          false,

        data:
          null,

        error:
          error.message

      });

    }

  }
);

// =====================================================
// History API
// =====================================================

app.get(
  "/api/history",
  (req, res) => {

    try {

      const days =
        Number(
          req.query.days || 7
        );

      const validDays =
        [1, 7, 30, 90]
          .includes(days)
          ? days
          : 7;

      const history =
        loadHistory();

      const from =
        Date.now() -
        validDays *
        24 *
        60 *
        60 *
        1000;

      const filtered =
        history.filter(
          item =>
            Number(
              item.timestamp
            ) >= from
        );

      res.json({

        success:
          true,

        days:
          validDays,

        data:
          filtered

      });

    } catch (error) {

      res.status(500).json({

        success:
          false,

        error:
          error.message

      });

    }

  }
);

// =====================================================
// 수동 업데이트 API
// =====================================================

app.get(
  "/api/update",
  async (req, res) => {

    try {

      /*
       * 중요:
       * 수동 업데이트도 5분 캐시와 Rate Limit 보호를 적용합니다.
       * force=true로 CoinGecko 요청을 강제로 발생시키지 않습니다.
       */

      const data =
        await updateData(false);

      if (!data) {

        return res.status(503).json({

          success:
            false,

          data:
            null,

          error:
            lastError ||
            "Unable to update data."

        });

      }

      res.json({

        success:
          true,

        data:
          data,

        cached:
          Date.now() -
            lastSuccessfulUpdate >
          CACHE_DURATION,

        lastError:
          lastError

      });

    } catch (error) {

      console.error(
        "/api/update 오류:",
        error.message
      );

      if (latestData) {

        return res.json({

          success:
            true,

          data:
            latestData,

          cached:
            true,

          stale:
            true,

          error:
            error.message

        });

      }

      res.status(503).json({

        success:
          false,

        data:
          null,

        error:
          error.message

      });

    }

  }
);

// =====================================================
// 서버 상태
// =====================================================

app.get(
  "/api/status",
  (req, res) => {

    const history =
      loadHistory();

    const cacheAge =
      lastSuccessfulUpdate
        ? Date.now() -
          lastSuccessfulUpdate
        : null;

    res.json({

      success:
        true,

      category:
        CATEGORY_ID,

      latestData:
        latestData,

      historyCount:
        history.length,

      cacheDurationMinutes:
        5,

      cacheAgeSeconds:
        cacheAge !== null
          ? Math.floor(
              cacheAge / 1000
            )
          : null,

      isUpdating:
        isUpdating,

      lastSuccessfulUpdate:
        lastSuccessfulUpdate
          ? new Date(
              lastSuccessfulUpdate
            ).toISOString()
          : null,

      lastUpdateAttempt:
        lastUpdateAttempt
          ? new Date(
              lastUpdateAttempt
            ).toISOString()
          : null,

      lastError:
        lastError,

      serverTime:
        new Date().toISOString()

    });

  }
);

// =====================================================
// 서버 시작
// =====================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log("");

    console.log(
      "=========================================="
    );

    console.log(
      " USDP.POOL Dashboard"
    );

    console.log(
      "=========================================="
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Category: ${CATEGORY_ID}`
    );

    console.log(
      "Cache: 5 minutes"
    );

    console.log(
      "Rate Limit protection: ENABLED"
    );

    console.log(
      "=========================================="
    );

    console.log("");

  }
);
