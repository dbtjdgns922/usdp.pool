const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 3000;

// =====================================================
// CoinGecko 설정
// =====================================================

// 서버 환경변수로 API Key를 넣는 것을 권장합니다.
// Windows:
// set COINGECKO_API_KEY=여기에_API_KEY
//
// Linux:
// export COINGECKO_API_KEY=여기에_API_KEY

const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY || "";

// 사용자가 요청한 CoinGecko 카테고리
const CATEGORY_ID = "pools-launchpad";

const API_URL =
  "https://api.coingecko.com/api/v3/coins/categories";

// API 요청 간격
const UPDATE_INTERVAL = 5 * 60 * 1000;

// 데이터 저장 파일
const HISTORY_FILE = path.join(__dirname, "history.json");

// =====================================================
// Express
// =====================================================

app.use(express.static(__dirname));

app.use(express.json());

// =====================================================
// history.json 읽기
// =====================================================

function loadHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) {
      return [];
    }

    const data = fs.readFileSync(HISTORY_FILE, "utf8");

    if (!data.trim()) {
      return [];
    }

    const parsed = JSON.parse(data);

    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("history.json 읽기 오류:", error);
    return [];
  }
}

// =====================================================
// history.json 저장
// =====================================================

function saveHistory(history) {
  try {
    fs.writeFileSync(
      HISTORY_FILE,
      JSON.stringify(history, null, 2),
      "utf8"
    );
  } catch (error) {
    console.error("history.json 저장 오류:", error);
  }
}

// =====================================================
// 숫자 처리
// =====================================================

function safeNumber(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  return number;
}

// =====================================================
// CoinGecko API 호출
// =====================================================

async function fetchCategory() {
  const headers = {
    accept: "application/json"
  };

  // API Key가 있으면 헤더에 추가
  if (COINGECKO_API_KEY) {
    headers["x-cg-demo-api-key"] = COINGECKO_API_KEY;
  }

  const response = await fetch(API_URL, {
    method: "GET",
    headers
  });

  if (!response.ok) {
    const text = await response.text();

    throw new Error(
      `CoinGecko API 오류 ${response.status}: ${text}`
    );
  }

  const categories = await response.json();

  if (!Array.isArray(categories)) {
    throw new Error("CoinGecko 응답 형식이 올바르지 않습니다.");
  }

  const category = categories.find(
    item => item.id === CATEGORY_ID
  );

  if (!category) {
    throw new Error(
      `카테고리 '${CATEGORY_ID}'를 찾을 수 없습니다.`
    );
  }

  return {
    timestamp: Date.now(),

    date: new Date().toISOString(),

    categoryId: category.id,

    categoryName: category.name,

    marketCap: safeNumber(category.market_cap),

    volume24h: safeNumber(category.volume_24h),

    marketCapChange24h: safeNumber(
      category.market_cap_change_24h
    ),

    updatedAt: category.updated_at || null
  };
}

// =====================================================
// 데이터 수집
// =====================================================

let latestData = null;

async function updateData() {
  try {
    console.log(
      `[${new Date().toLocaleString()}] CoinGecko 데이터 업데이트 중...`
    );

    const data = await fetchCategory();

    latestData = data;

    let history = loadHistory();

    history.push(data);

    // 최근 90일만 보관
    const ninetyDaysAgo =
      Date.now() - 90 * 24 * 60 * 60 * 1000;

    history = history.filter(
      item => Number(item.timestamp) >= ninetyDaysAgo
    );

    saveHistory(history);

    console.log(
      "업데이트 완료:",
      {
        marketCap: data.marketCap,
        volume24h: data.volume24h
      }
    );
  } catch (error) {
    console.error(
      "데이터 업데이트 실패:",
      error.message
    );
  }
}

// =====================================================
// 처음 서버 실행
// =====================================================

updateData();

// 5분마다 업데이트
setInterval(updateData, UPDATE_INTERVAL);

// =====================================================
// 현재 데이터 API
// =====================================================

app.get("/api/current", async (req, res) => {
  try {
    if (!latestData) {
      await updateData();
    }

    res.json({
      success: true,
      data: latestData
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =====================================================
// 역사 데이터 API
// =====================================================

app.get("/api/history", (req, res) => {
  try {
    const days = Number(req.query.days || 7);

    const validDays =
      [1, 7, 30, 90].includes(days)
        ? days
        : 7;

    const history = loadHistory();

    const from =
      Date.now() -
      validDays * 24 * 60 * 60 * 1000;

    const filtered = history.filter(
      item => Number(item.timestamp) >= from
    );

    res.json({
      success: true,

      days: validDays,

      data: filtered
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =====================================================
// 수동 업데이트 API
// =====================================================

app.get("/api/update", async (req, res) => {
  try {
    await updateData();

    res.json({
      success: true,
      data: latestData
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =====================================================
// 서버 상태
// =====================================================

app.get("/api/status", (req, res) => {
  const history = loadHistory();

  res.json({
    success: true,

    category: CATEGORY_ID,

    latestData,

    historyCount: history.length,

    updateIntervalMinutes: 5,

    serverTime: new Date().toISOString()
  });
});

// =====================================================
// 서버 시작
// =====================================================

app.listen(PORT, () => {
  console.log("");
  console.log("==========================================");
  console.log(" Pools / Launchpad Dashboard");
  console.log("==========================================");
  console.log(`서버: http://localhost:${PORT}`);
  console.log(`카테고리: ${CATEGORY_ID}`);
  console.log("업데이트: 5분");
  console.log("==========================================");
  console.log("");
});