// ============================================
// ANALYTICS DASHBOARD - BACKEND SERVER (v2)
// Node.js + Express + Google Sheets API
// Real-time data + Smart query processing
// ============================================

const express = require('express');
const cors = require('cors');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json());

// Configuration
const SHEET_ID = process.env.SHEET_ID || '1WFHuhA2M9rmHRfxVeUWuGWRvgcDC2W4jSyIgXRvLpVw';
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// User database (in production, use a real database)
const VALID_USERS = {
  'demo@noon.com': 'demo123',
  'ceo@noon.com': 'ceo123',
  'admin@noon.com': 'admin123'
};

// Data caching (refresh every hour)
let cachedData = null;
let lastCacheTime = null;
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour

// ============================================
// AUTHENTICATION ENDPOINTS
// ============================================

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  if (VALID_USERS[email] === password) {
    const token = jwt.sign(
      { email, loginTime: new Date() },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      success: true,
      token,
      email,
      message: 'Login successful'
    });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.user = user;
    next();
  });
}

// ============================================
// GOOGLE SHEETS INTEGRATION
// ============================================

async function initializeSheet() {
  const doc = new GoogleSpreadsheet(SHEET_ID);

  await doc.useServiceAccountAuth({
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
  });

  await doc.loadInfo();
  return doc;
}

async function getSheetData() {
  try {
    // Check cache
    if (cachedData && lastCacheTime && (Date.now() - lastCacheTime) < CACHE_DURATION) {
      console.log('Using cached data');
      return cachedData;
    }

    console.log('Fetching fresh data from Google Sheets...');
    const doc = await initializeSheet();
    const sheet = doc.sheetsByTitle['DoD Growth Trends'];
    
    if (!sheet) {
      throw new Error('Sheet "DoD Growth Trends" not found');
    }

    const rows = await sheet.getRows();
    
    // Parse data and handle various formats
    const parsedData = rows.map(row => {
      return {
        date: row.get('Date') || '',
        'Delivered orders': parseNumber(row.get('Delivered orders')),
        'Sessions': parseNumber(row.get('Sessions')),
        'AOV': parseDecimal(row.get('AOV')),
        'CR': parseDecimal(row.get('CR')),
        'ATC': parseDecimal(row.get('ATC')),
        'ATC2P': parseDecimal(row.get('ATC2P')),
        'Cart Page %': parseDecimal(row.get('Cart Page %')),
        'C2O': parseDecimal(row.get('C2O')),
        'ASP': parseDecimal(row.get('ASP')),
        'ITO': parseDecimal(row.get('ITO')),
        'Customers': parseNumber(row.get('Customers')),
        'New Customers': parseNumber(row.get('New Customers')),
        'Repeat Customers': parseNumber(row.get('Repeat Customers')),
        'GMV': parseNumber(row.get('GMV')),
        'TPC': parseDecimal(row.get('TPC')),
        'AOV - Excl Electronics, Beauty, Toys': parseDecimal(row.get('AOV - Excl Electronics, Beauty, Toys')),
        'New Users': parseNumber(row.get('New Users')),
        'Raw Data': row._rawData
      };
    }).filter(row => row.date); // Only include rows with dates

    cachedData = parsedData;
    lastCacheTime = Date.now();
    
    console.log(`Loaded ${parsedData.length} rows from Google Sheets`);
    return parsedData;

  } catch (error) {
    console.error('Error fetching sheet data:', error);
    throw error;
  }
}

function parseNumber(val) {
  if (!val || val === '#N/A' || val === '#DIV/0!') return null;
  const num = parseFloat(String(val).replace(/,/g, ''));
  return isNaN(num) ? null : num;
}

function parseDecimal(val) {
  if (!val || val === '#N/A' || val === '#DIV/0!') return null;
  const num = parseFloat(String(val).replace(/,/g, ''));
  return isNaN(num) ? null : num;
}

// ============================================
// NATURAL LANGUAGE QUERY PROCESSING
// ============================================

// Metric definitions mapping
const METRIC_KEYWORDS = {
  'order': ['Delivered orders'],
  'session': ['Sessions'],
  'aov': ['AOV'],
  'average order value': ['AOV'],
  'cr': ['CR'],
  'conversion': ['CR'],
  'conversion rate': ['CR'],
  'atc': ['ATC'],
  'add to cart': ['ATC'],
  'customer': ['Customers'],
  'customers': ['Customers'],
  'new customer': ['New Customers'],
  'new': ['New Customers'],
  'repeat customer': ['Repeat Customers'],
  'repeat': ['Repeat Customers'],
  'gmv': ['GMV'],
  'merchandise value': ['GMV'],
  'tpc': ['TPC'],
  'transaction': ['TPC'],
  'asp': ['ASP'],
  'c2o': ['C2O'],
  'growth': ['growth'],
};

function parseUserQuery(queryText, allData) {
  const text = queryText.toLowerCase().trim();
  
  // Extract dates
  const dates = extractDates(text, allData);
  
  // Extract metrics
  const metrics = extractMetrics(text);
  
  // Detect query type
  const type = detectQueryType(text);
  
  return { dates, metrics, type, originalQuery: queryText };
}

function extractDates(queryText, allData) {
  const text = queryText.toLowerCase();
  const allDates = allData.map(row => row.date).filter(d => d);
  const results = new Set();

  // Explicit dates (MM/DD/YY format)
  const dateRegex = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/g;
  let match;
  while ((match = dateRegex.exec(queryText)) !== null) {
    const month = parseInt(match[1]);
    const day = parseInt(match[2]);
    const year = match[3].length === 2 ? 2000 + parseInt(match[3]) : parseInt(match[3]);
    
    const found = allDates.find(d => {
      try {
        const dateObj = new Date(d);
        return dateObj.getMonth() + 1 === month && 
               dateObj.getDate() === day && 
               dateObj.getFullYear() === year;
      } catch (e) {
        return false;
      }
    });
    
    if (found) results.add(found);
  }

  // Relative dates
  const today = new Date();

  if (text.includes('today')) {
    const todayStr = allDates.find(d => {
      try {
        const dateObj = new Date(d);
        return dateObj.toDateString() === today.toDateString();
      } catch (e) { return false; }
    });
    if (todayStr) results.add(todayStr);
  }

  if (text.includes('yesterday')) {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = allDates.find(d => {
      try {
        const dateObj = new Date(d);
        return dateObj.toDateString() === yesterday.toDateString();
      } catch (e) { return false; }
    });
    if (yesterdayStr) results.add(yesterdayStr);
  }

  if (text.includes('last 7 days') || text.includes('last week') || text.includes('week')) {
    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const found = allDates.find(date => {
        try {
          const dateObj = new Date(date);
          return dateObj.toDateString() === d.toDateString();
        } catch (e) { return false; }
      });
      if (found) results.add(found);
    }
  }

  if (text.includes('last 30 days') || text.includes('month')) {
    for (let i = 0; i < 30; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const found = allDates.find(date => {
        try {
          const dateObj = new Date(date);
          return dateObj.toDateString() === d.toDateString();
        } catch (e) { return false; }
      });
      if (found) results.add(found);
    }
  }

  // Default to last available date if nothing specified
  if (results.size === 0 && allDates.length > 0) {
    results.add(allDates[0]);
  }

  return Array.from(results);
}

function extractMetrics(queryText) {
  const text = queryText.toLowerCase();
  const found = new Set();

  Object.entries(METRIC_KEYWORDS).forEach(([keyword, metrics]) => {
    if (text.includes(keyword)) {
      metrics.forEach(m => {
        if (m !== 'growth') found.add(m);
      });
    }
  });

  // If asking for growth, return common metrics
  if (text.includes('growth') || text.includes('change') || text.includes('trend')) {
    return ['growth'];
  }

  // Default metrics
  if (found.size === 0) {
    return ['Delivered orders', 'Sessions', 'CR', 'AOV', 'Customers'];
  }

  return Array.from(found);
}

function detectQueryType(queryText) {
  const text = queryText.toLowerCase();
  
  if (text.includes('compare') || text.includes('vs') || text.includes('difference')) {
    return 'comparison';
  }
  if (text.includes('growth') || text.includes('trend') || text.includes('change')) {
    return 'growth';
  }
  if (text.includes('list') || text.includes('all')) {
    return 'list';
  }
  
  return 'summary';
}

async function processQuery(queryText) {
  try {
    const data = await getSheetData();
    
    if (!data || data.length === 0) {
      return {
        type: 'error',
        message: 'No data available from sheet'
      };
    }

    const { dates, metrics, type } = parseUserQuery(queryText, data);

    if (!dates || dates.length === 0) {
      return {
        type: 'error',
        message: 'Could not understand the dates in your query. Try "orders on 2/10/26" or "yesterday"'
      };
    }

    // Filter data for requested dates
    const filteredData = data.filter(row => dates.includes(row.date))
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    // Handle growth metrics
    if (metrics.includes('growth')) {
      return buildGrowthResponse(filteredData);
    }

    // Handle comparisons
    if (type === 'comparison' && filteredData.length > 1) {
      return buildComparisonResponse(filteredData, metrics);
    }

    // Handle normal summary
    return buildSummaryResponse(filteredData, metrics);

  } catch (error) {
    console.error('Query error:', error);
    return {
      type: 'error',
      message: `Error processing query: ${error.message}`
    };
  }
}

function buildGrowthResponse(filteredData) {
  const results = {
    type: 'metrics',
    data: []
  };

  if (filteredData.length === 0) return results;

  const current = filteredData[0];
  const previous = filteredData.length > 1 ? filteredData[1] : null;

  const keyMetrics = ['Delivered orders', 'Sessions', 'CR', 'AOV', 'Customers', 'GMV'];

  keyMetrics.forEach(metric => {
    const value = current[metric];
    if (value !== null && value !== undefined) {
      let change = null;
      let positive = null;

      if (previous && previous[metric]) {
        const changePercent = ((value - previous[metric]) / previous[metric] * 100);
        change = changePercent.toFixed(1);
        positive = changePercent >= 0;
      }

      results.data.push({
        label: formatMetricLabel(metric),
        value: formatValue(metric, value),
        change: change ? `${positive ? '↑' : '↓'} ${Math.abs(change)}%` : 'N/A',
        positive: positive,
        metric: metric,
        date: current.date
      });
    }
  });

  return results;
}

function buildComparisonResponse(filteredData, metrics) {
  const results = {
    type: 'comparison',
    data: []
  };

  const current = filteredData[0];
  const previous = filteredData[1];

  (metrics.length > 0 ? metrics : ['Delivered orders', 'Sessions', 'AOV']).forEach(metric => {
    const currentVal = current[metric];
    const prevVal = previous[metric];

    if (currentVal !== null && prevVal !== null) {
      const change = ((currentVal - prevVal) / prevVal * 100).toFixed(1);
      const positive = parseFloat(change) >= 0;

      results.data.push({
        label: formatMetricLabel(metric),
        date1: current.date,
        value1: formatValue(metric, currentVal),
        date2: previous.date,
        value2: formatValue(metric, prevVal),
        change: `${positive ? '+' : ''}${change}%`,
        positive: positive,
        metric: metric
      });
    }
  });

  return results;
}

function buildSummaryResponse(filteredData, metrics) {
  const results = {
    type: 'metrics',
    data: []
  };

  filteredData.forEach(row => {
    (metrics.length > 0 ? metrics : ['Delivered orders', 'Sessions', 'AOV']).forEach(metric => {
      const value = row[metric];
      
      if (value !== null && value !== undefined) {
        results.data.push({
          label: `${formatMetricLabel(metric)} (${row.date})`,
          value: formatValue(metric, value),
          metric: metric,
          date: row.date
        });
      }
    });
  });

  return results;
}

function formatMetricLabel(metric) {
  const labels = {
    'Delivered orders': 'Orders',
    'Sessions': 'Sessions',
    'AOV': 'Average Order Value',
    'CR': 'Conversion Rate',
    'ATC': 'Add to Cart Rate',
    'Customers': 'Customers',
    'GMV': 'Gross Merchandise Value',
    'TPC': 'Transactions per Customer',
    'New Customers': 'New Customers',
    'Repeat Customers': 'Repeat Customers',
    'ASP': 'Average Selling Price',
    'C2O': 'Cart to Order',
    'ITO': 'Items per Transaction'
  };
  return labels[metric] || metric;
}

function formatValue(metric, value) {
  if (value === null || value === undefined) return 'N/A';

  const numValue = parseFloat(value);
  if (isNaN(numValue)) return String(value);

  // Percentages
  if (['CR', 'ATC', 'C2O', 'Cart Page %'].includes(metric)) {
    return `${numValue.toFixed(1)}%`;
  }

  // Currency
  if (['AOV', 'GMV', 'ASP'].includes(metric)) {
    return `₹${numValue.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
  }

  // Decimals
  if (['TPC', 'ITO', 'ATC2P'].includes(metric)) {
    return numValue.toFixed(2);
  }

  // Numbers with commas
  return numValue.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

// ============================================
// API ENDPOINTS
// ============================================

app.post('/api/query', authenticateToken, async (req, res) => {
  try {
    const { query } = req.body;

    if (!query || query.trim().length === 0) {
      return res.status(400).json({ error: 'Query is required' });
    }

    console.log(`Query from ${req.user.email}: ${query}`);

    const results = await processQuery(query);

    res.json({
      success: true,
      results: results
    });
  } catch (error) {
    console.error('Query error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to process query'
    });
  }
});

app.get('/api/data', authenticateToken, async (req, res) => {
  try {
    const data = await getSheetData();
    res.json({
      success: true,
      count: data.length,
      latestDate: data.length > 0 ? data[0].date : null,
      data: data
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date(),
    cache: cachedData ? 'active' : 'empty'
  });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'production' ? 'An error occurred' : err.message
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Analytics API running on port ${PORT}`);
  console.log(`📊 Sheet ID: ${SHEET_ID}`);
  console.log(`⚙️ Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
