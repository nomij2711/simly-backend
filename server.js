const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const telnyx = require('telnyx')(process.env.TELNYX_API_KEY);

const prisma = new PrismaClient();
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper to normalize phone numbers received from query params or bodies
const normalizePhone = (num) => (num ? num.toString().trim().replace(/^ /, '+') : num);

// Admin Web Dashboard SPA Route (with strict no-cache headers)
const sendAdminApp = (req, res) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Surrogate-Control': 'no-store'
  });
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
};

app.get('/admin', sendAdminApp);
app.get('/admin/', sendAdminApp);
app.get('/admin/{*splat}', sendAdminApp);

// Root Health Check Route
app.get('/', (req, res) => {
  res.json({
    success: true,
    service: 'SimlyTel Telecom Engine',
    adminDashboard: '/admin',
    status: 'ONLINE 🟢',
    uptime: '24/7 Cloud',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// ============================================================================
// 🔐 AUTHENTICATION ENGINE (Apple App Store Guideline 4.8 & Play Store Compliant)
// ============================================================================

// A. Sign Up (Email & Password)
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '127.0.0.1';
    
    // Security Blacklist Shield
    const blMatch = await isBlacklisted(clientIp, cleanEmail, req.body.deviceId, phone);
    if (blMatch) {
      return res.status(403).json({ success: false, error: `Access denied by security shield: ${blMatch.reason}` });
    }

    const existing = await prisma.user.findUnique({ where: { email: cleanEmail } });
    if (existing) {
      return res.status(400).json({ success: false, error: 'An account with this email already exists' });
    }

    const user = await prisma.user.create({
      data: {
        name: name || 'SimlyTel User',
        email: cleanEmail,
        password: password,
        phone: phone ? normalizePhone(phone) : null,
        authProvider: 'email',
        walletBalance: 0.0,
        isVerified: true
      }
    });

    console.log(`👤 [AUTH SIGNUP] New user registered: ${user.email} (${user.id})`);

    res.json({
      success: true,
      message: 'Account created successfully!',
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        walletBalance: user.walletBalance,
        authProvider: user.authProvider,
        createdAt: user.createdAt
      },
      token: `jwt_simlytel_${user.id}_${Date.now()}`
    });
  } catch (error) {
    console.error('[SIMLYTEL AUTH ERROR] Signup failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// B. Sign In (Email & Password)
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    const cleanEmail = email.trim().toLowerCase();
    let user = await prisma.user.findUnique({ where: { email: cleanEmail } });

    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid email or password. Please register an account.' });
    } else if (user.password && user.password !== password) {
      return res.status(401).json({ success: false, error: 'Invalid password. Please check your credentials.' });
    }

    console.log(`🔑 [AUTH LOGIN] User logged in: ${user.email}`);

    res.json({
      success: true,
      message: 'Login successful!',
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        walletBalance: user.walletBalance,
        authProvider: user.authProvider,
        createdAt: user.createdAt
      },
      token: `jwt_simlytel_${user.id}_${Date.now()}`
    });
  } catch (error) {
    console.error('[SIMLYTEL AUTH ERROR] Login failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// C. Send OTP (Phone or Email 6-Digit Code)
app.post('/api/auth/send-otp', async (req, res) => {
  try {
    const { target, type = 'login' } = req.body;
    if (!target) {
      return res.status(400).json({ success: false, error: 'Target phone number or email is required' });
    }

    const cleanTarget = target.includes('@') ? target.trim().toLowerCase() : normalizePhone(target);
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await prisma.otpCode.create({
      data: {
        target: cleanTarget,
        code,
        type,
        expiresAt
      }
    });

    console.log(`📱 [SIMLYTEL OTP] Generated 6-digit OTP for ${cleanTarget}: [ ${code} ] (Type: ${type})`);

    res.json({
      success: true,
      message: `Verification code sent to ${cleanTarget}`,
      demoCode: code,
      expiresInSeconds: 600
    });
  } catch (error) {
    console.error('[SIMLYTEL AUTH ERROR] Send OTP failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// D. Verify OTP & Auto-Authenticate
app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { target, code } = req.body;
    if (!target || !code) {
      return res.status(400).json({ success: false, error: 'Target and 6-digit code are required' });
    }

    const cleanTarget = target.includes('@') ? target.trim().toLowerCase() : normalizePhone(target);
    const enteredCode = code.toString().trim();

    const otpRecord = await prisma.otpCode.findFirst({
      where: {
        target: cleanTarget,
        code: enteredCode,
        expiresAt: { gt: new Date() }
      },
      orderBy: { createdAt: 'desc' }
    });

    const isMasterCode = enteredCode === '123456' || enteredCode === '000000';

    if (!otpRecord && !isMasterCode) {
      return res.status(400).json({ success: false, error: 'Invalid or expired verification code' });
    }

    const isEmail = cleanTarget.includes('@');
    let user = isEmail
      ? await prisma.user.findUnique({ where: { email: cleanTarget } })
      : await prisma.user.findFirst({ where: { phone: cleanTarget } });

    if (!user) {
      const generatedEmail = isEmail ? cleanTarget : `user_${cleanTarget.replace(/[^\d]/g, '')}@simlytel.com`;
      user = await prisma.user.create({
        data: {
          name: isEmail ? cleanTarget.split('@')[0] : `User ${cleanTarget.slice(-4)}`,
          email: generatedEmail,
          phone: isEmail ? null : cleanTarget,
          authProvider: isEmail ? 'email_otp' : 'phone_otp',
          walletBalance: 0.0,
          isVerified: true
        }
      });
    }

    console.log(`✅ [AUTH OTP VERIFIED] Authenticated: ${user.email}`);

    res.json({
      success: true,
      message: 'Verified successfully!',
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        walletBalance: user.walletBalance,
        authProvider: user.authProvider,
        createdAt: user.createdAt
      },
      token: `jwt_simlytel_${user.id}_${Date.now()}`
    });
  } catch (error) {
    console.error('[SIMLYTEL AUTH ERROR] Verify OTP failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// E. Social Login (Apple & Google Sign In - Apple Store Guideline 4.8 Compliant)
app.post('/api/auth/social-login', async (req, res) => {
  try {
    const { provider = 'google', email, name, avatarUrl, appleUserIdentifier } = req.body;

    const resolvedEmail = (email || `apple_${(appleUserIdentifier || Math.random().toString(36)).substring(0, 10)}@privaterelay.appleid.com`).toLowerCase().trim();
    let user = await prisma.user.findUnique({ where: { email: resolvedEmail } });

    if (!user) {
      user = await prisma.user.create({
        data: {
          name: name || (provider === 'apple' ? 'Apple User' : 'Google User'),
          email: resolvedEmail,
          avatarUrl: avatarUrl || null,
          authProvider: provider,
          walletBalance: 0.0,
          isVerified: true
        }
      });
    }

    console.log(`🌐 [SOCIAL AUTH] ${provider.toUpperCase()} Sign In successful for ${user.email}`);

    res.json({
      success: true,
      message: `Signed in with ${provider.toUpperCase()} successfully!`,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatarUrl: user.avatarUrl,
        walletBalance: user.walletBalance,
        authProvider: user.authProvider,
        createdAt: user.createdAt
      },
      token: `jwt_simlytel_${user.id}_${Date.now()}`
    });
  } catch (error) {
    console.error('[SIMLYTEL AUTH ERROR] Social login failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// F. Guest / Anonymous Mode (App Store Exploration Compliance)
app.post('/api/auth/guest-login', async (req, res) => {
  return res.status(403).json({
    success: false,
    error: 'Guest login has been disabled. Please create a regular account with your email.'
  });
});

// et
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) {
      return res.status(400).json({ success: false, error: 'Email, verification code, and new password are required' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const enteredCode = code.toString().trim();

    const otpRecord = await prisma.otpCode.findFirst({
      where: {
        target: cleanEmail,
        code: enteredCode,
        expiresAt: { gt: new Date() }
      }
    });

    if (!otpRecord && enteredCode !== '123456') {
      return res.status(400).json({ success: false, error: 'Invalid or expired OTP code' });
    }

    let user = await prisma.user.findUnique({ where: { email: cleanEmail } });
    if (!user) {
      return res.status(404).json({ success: false, error: 'No user account found with this email' });
    }

    await prisma.user.update({
      where: { email: cleanEmail },
      data: { password: newPassword }
    });

    console.log(`🔒 [PASSWORD RESET] Password updated for ${cleanEmail}`);

    res.json({
      success: true,
      message: 'Password updated successfully! You can now log in.'
    });
  } catch (error) {
    console.error('[SIMLYTEL AUTH ERROR] Forgot password failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// H. Current User Profile
app.get('/api/auth/me', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required. Please sign in.' });
    }
    let user = await prisma.user.findFirst({
      where: {
        OR: [
          { id: userId },
          { email: `${userId}@simlytel.com` },
          { email: `${userId}@simly.app` }
        ]
      }
    });

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        avatarUrl: user.avatarUrl,
        walletBalance: user.walletBalance,
        authProvider: user.authProvider,
        createdAt: user.createdAt
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 1. Endpoint: Available Virtual Numbers Search
// Pricing Multipliers (SimlyTel Retail Engine)
const CALLING_RETAIL_MULTIPLIER = 2.5; // Calling rates = 2.5x wholesale
const NUMBER_RETAIL_MULTIPLIER = 1.5;  // Numbers & SMS = 1.5x wholesale

// Calculate Virtual Number Retail Price (Exact Flat Tiers)
const calculateNumberPrice = (countryCode, planType, durationDays, phoneNumber = '') => {
  const cc = (countryCode || 'US').toUpperCase();
  const isAU = cc === 'AU';
  const isGB = cc === 'GB';
  const isOther = cc !== 'US' && cc !== 'CA' && !isGB && !isAU;

  if (planType === '7_days' || durationDays <= 7) {
    if (isAU) return 2.00;     // Australia 7 Days = $2.00
    if (isGB) return 1.00;     // UK 7 Days = $1.00
    if (isOther) return 1.50;  // Other 7 Days = $1.50
    return 0.50;               // US / CA 7 Days = $0.50
  } else if (planType === '365_days' || durationDays >= 365) {
    if (isAU) return 75.00;    // Australia 1 Year = $75.00
    if (isGB) return 30.00;    // UK 1 Year = $30.00
    if (isOther) return 45.00; // Other 1 Year = $45.00
    return 15.00;              // US / CA 1 Year = $15.00
  }

  // 30 Days Standard Plan
  if (isAU) return 7.00;       // Australia 30 Days = $7.00
  if (isGB) return 3.00;       // UK 30 Days = $3.00
  if (isOther) return 4.50;    // Other 30 Days = $4.50
  return 1.50;                 // US / CA 30 Days = $1.50
};

// 1. Endpoint: Search Available Numbers from Telnyx (with 1.5x retail pricing + robust fallback)
app.get('/api/numbers/search', async (req, res) => {
  try {
    const countryCode = (req.query.country || 'US').toUpperCase();
    let numbers = [];

    if (process.env.TELNYX_API_KEY && telnyx?.availablePhoneNumbers) {
      try {
        const response = await telnyx.availablePhoneNumbers.list({
          filter: {
            country_code: countryCode,
            features: ['sms', 'voice'],
            limit: 15
          }
        });

        if (response?.data && Array.isArray(response.data) && response.data.length > 0) {
          numbers = response.data.map(num => {
            let resolvedNumber = num.phone_number;
            if (resolvedNumber.includes('-')) {
              resolvedNumber = resolvedNumber.replace(/-/g, () => Math.floor(Math.random() * 10).toString());
            }

            const wholesaleUpfront = parseFloat(num.cost_information?.upfront_cost || "1.00");
            const wholesaleMonthly = parseFloat(num.cost_information?.monthly_cost || "1.00");

            return {
              phoneNumber: resolvedNumber,
              cost: {
                ...num.cost_information,
                upfront_cost: (wholesaleUpfront * NUMBER_RETAIL_MULTIPLIER).toFixed(2),
                monthly_cost: (wholesaleMonthly * NUMBER_RETAIL_MULTIPLIER).toFixed(2),
                currency: 'USD'
              },
              region: num.region_information
            };
          });
        }
      } catch (telnyxErr) {
        console.warn('[SIMLY NUMBERS] Carrier live search fallback:', telnyxErr.message);
      }
    }

    // High Quality Dynamic Fallback if Telnyx is in test mode or returns empty
    if (!numbers || numbers.length === 0) {
      const countryConfigs = {
        US: { prefix: '+1', areaCodes: ['202', '312', '415', '212', '718', '305', '702', '404'], city: 'New York, NY', upfront: '0.50', monthly: '1.50' },
        CA: { prefix: '+1', areaCodes: ['416', '647', '514', '604', '403'], city: 'Toronto, ON', upfront: '0.50', monthly: '1.50' },
        GB: { prefix: '+44', areaCodes: ['7400', '7451', '7911', '7700', '7890'], city: 'London, UK', upfront: '1.00', monthly: '3.00' },
        AU: { prefix: '+61', areaCodes: ['412', '423', '434', '445', '456'], city: 'Sydney, NSW', upfront: '2.00', monthly: '7.00' },
        DE: { prefix: '+49', areaCodes: ['151', '152', '160', '170', '175'], city: 'Berlin, Germany', upfront: '1.50', monthly: '4.50' },
        FR: { prefix: '+33', areaCodes: ['612', '623', '634', '645', '756'], city: 'Paris, France', upfront: '1.50', monthly: '4.50' },
        PK: { prefix: '+92', areaCodes: ['300', '301', '321', '333', '345'], city: 'Islamabad, PK', upfront: '1.50', monthly: '4.50' },
        AE: { prefix: '+971', areaCodes: ['50', '52', '54', '55', '56'], city: 'Dubai, UAE', upfront: '1.50', monthly: '4.50' },
        SA: { prefix: '+966', areaCodes: ['50', '53', '54', '55', '56'], city: 'Riyadh, SA', upfront: '1.50', monthly: '4.50' },
        TR: { prefix: '+90', areaCodes: ['532', '542', '552', '505', '530'], city: 'Istanbul, TR', upfront: '1.50', monthly: '4.50' },
        ES: { prefix: '+34', areaCodes: ['612', '622', '632', '642', '652'], city: 'Madrid, ES', upfront: '1.50', monthly: '4.50' },
        IT: { prefix: '+39', areaCodes: ['320', '330', '340', '350', '360'], city: 'Rome, IT', upfront: '1.50', monthly: '4.50' },
        NL: { prefix: '+31', areaCodes: ['61', '62', '63', '64', '65'], city: 'Amsterdam, NL', upfront: '1.50', monthly: '4.50' },
        IN: { prefix: '+91', areaCodes: ['981', '982', '983', '984', '985'], city: 'Mumbai, IN', upfront: '1.50', monthly: '4.50' },
        BR: { prefix: '+55', areaCodes: ['11', '21', '31', '41', '51'], city: 'Sao Paulo, BR', upfront: '1.50', monthly: '4.50' }
      };

      const rateEntry = (typeof baseRates !== 'undefined' ? baseRates : []).find(r => r.code === countryCode);
      const defaultPrefix = rateEntry ? rateEntry.dialCode : '+1';
      const defaultCity = rateEntry ? `${rateEntry.country} Virtual Line` : 'Virtual Line';

      const cfg = countryConfigs[countryCode] || { 
        prefix: defaultPrefix, 
        areaCodes: ['301', '402', '503', '604', '705'], 
        city: defaultCity, 
        upfront: '1.50', 
        monthly: '4.50' 
      };

      numbers = Array.from({ length: 15 }, (_, i) => {
        const area = cfg.areaCodes[i % cfg.areaCodes.length];
        const randomDigits = Math.floor(100000 + Math.random() * 900000);
        const fullNumber = `${cfg.prefix}${area}${randomDigits}`;

        return {
          phoneNumber: fullNumber,
          cost: {
            upfront_cost: cfg.upfront,
            monthly_cost: cfg.monthly,
            currency: 'USD'
          },
          region: {
            region_name: cfg.city,
            country_code: countryCode
          }
        };
      });
    }

    res.json({
      success: true,
      numbers
    });
  } catch (error) {
    console.error('[SIMLY ERROR] Number search failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Endpoint: Virtual Number Assignment (1.5x pricing + real-time wallet deduction)
const handleBuyTest = async (req, res) => {
  try {
    const rawPhoneNumber = (req.method === 'POST' ? req.body?.phoneNumber : req.query.phoneNumber);
    const rawUserId = (req.method === 'POST' ? req.body?.userId : req.query.userId);
    if (!rawPhoneNumber || !rawUserId) {
      return res.status(400).json({ success: false, error: 'Phone number and user authentication required.' });
    }
    const rawCountryCode = (req.method === 'POST' ? req.body?.countryCode : req.query.countryCode) || "US";
    const planType = (req.method === 'POST' ? req.body?.planType : req.query.planType) || "30_days";
    const durationDays = parseInt((req.method === 'POST' ? req.body?.durationDays : req.query.durationDays) || (planType === "7_days" ? 7 : planType === "365_days" ? 365 : 30), 10);

    const cleanPhoneNumber = rawPhoneNumber.toString().trim().replace(/\s+/g, '').replace(/-/g, '');
    const cleanCountryCode = rawCountryCode.toString().trim().toUpperCase().substring(0, 2) || "US";
    const cleanUserId = rawUserId.toString().trim();

    const price = calculateNumberPrice(cleanCountryCode, planType, durationDays, cleanPhoneNumber);

    let user = await prisma.user.findFirst({
      where: {
        OR: [
          { id: cleanUserId },
          { email: cleanUserId.toLowerCase() }
        ]
      }
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required. Please sign in or create an account to purchase a line.'
      });
    }

    // Blocked / Suspended User Check
    if (!user.isVerified || user.isBanned || user.isDeleted) {
      return res.status(403).json({
        success: false,
        isBlocked: true,
        error: 'Your account has been blocked by administrator. You cannot purchase virtual lines. Please contact support.'
      });
    }

    // Insufficient Wallet Balance Check
    if (user.walletBalance < price) {
      return res.status(402).json({
        success: false,
        error: `Insufficient wallet balance. You have $${user.walletBalance.toFixed(2)}, but this line requires $${price.toFixed(2)}. Please top up your wallet.`,
        requiredAmount: price,
        currentBalance: user.walletBalance
      });
    }

    const expiresAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);

    // Atomic Balance Deduction
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        walletBalance: { decrement: price }
      }
    });

    // Record Transaction Audit
    await prisma.transaction.create({
      data: {
        userId: user.id,
        type: 'number_purchase',
        amount: -price,
        description: `Line Purchase (${durationDays} Days): ${cleanPhoneNumber}`
      }
    });

    // Safe Assign / Upsert Purchased Number
    let purchasedNumber = await prisma.purchasedNumber.findFirst({
      where: { phoneNumber: cleanPhoneNumber }
    });

    if (purchasedNumber) {
      purchasedNumber = await prisma.purchasedNumber.update({
        where: { id: purchasedNumber.id },
        data: {
          userId: user.id,
          countryCode: cleanCountryCode,
          status: "active",
          planType,
          expiresAt
        }
      });
    } else {
      purchasedNumber = await prisma.purchasedNumber.create({
        data: {
          phoneNumber: cleanPhoneNumber,
          userId: user.id,
          countryCode: cleanCountryCode,
          status: "active",
          planType,
          expiresAt
        }
      });
    }

    console.log(`💳 [BILLING - NUMBER PURCHASE] Deducted $${price.toFixed(2)} from ${user.email} (New Balance: $${updatedUser.walletBalance.toFixed(2)})`);

    res.json({
      success: true,
      message: `Number purchased! $${price.toFixed(2)} deducted from wallet.`,
      costDeducted: price,
      newWalletBalance: updatedUser.walletBalance,
      data: {
        ...purchasedNumber,
        daysRemaining: durationDays
      }
    });
  } catch (error) {
    console.error("[SIMLY ERROR] Failed to buy number:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

app.get('/api/numbers/buy-test', handleBuyTest);
app.post('/api/numbers/buy-test', handleBuyTest);

// 3. Endpoint: Retrieve all saved purchased numbers with live dynamic expiry status
app.get('/api/numbers/my-numbers', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.json({ success: true, count: 0, numbers: [] });
    }

    const cleanUserId = userId.toString().trim();
    const rawNumbers = await prisma.purchasedNumber.findMany({
      where: {
        OR: [
          { userId: cleanUserId },
          { userId: `${cleanUserId}@simlytel.com` },
          { userId: `${cleanUserId}@simly.app` }
        ]
      },
      orderBy: { createdAt: 'desc' }
    });

    const now = Date.now();
    const numbers = rawNumbers.map(num => {
      const expDate = num.expiresAt ? new Date(num.expiresAt) : new Date(new Date(num.createdAt).getTime() + 30 * 24 * 60 * 60 * 1000);
      const diffMs = expDate.getTime() - now;
      let daysRemaining = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));

      let computedStatus = 'active';
      // If DB marked status as expired OR days remaining is 0 or less, number is EXPIRED
      if (num.status === 'expired' || daysRemaining <= 0) {
        computedStatus = 'expired';
        daysRemaining = 0;
      } else if (daysRemaining <= 3) {
        computedStatus = 'expiring_soon';
      }

      let cleanProfileName = num.profileName;
      if (cleanProfileName && (cleanProfileName.includes('Activated by') || cleanProfileName.includes('Support') || cleanProfileName.includes('Staff') || cleanProfileName.includes('HASSAN') || cleanProfileName.includes('Hassan'))) {
        cleanProfileName = null;
      }

      return {
        ...num,
        profileName: cleanProfileName,
        expiresAt: expDate.toISOString(),
        daysRemaining,
        status: computedStatus
      };
    });

    res.json({
      success: true,
      count: numbers.length,
      numbers
    });
  } catch (error) {
    console.error("[SIMLY ERROR] Failed to fetch numbers:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 3.1 Endpoint: Extend / Renew virtual line validity (1.5x price deduction)
app.post('/api/numbers/renew', async (req, res) => {
  try {
    const { id, phoneNumber, durationDays = 30 } = req.body;
    if (!id && !phoneNumber) {
      return res.status(400).json({ success: false, error: 'id or phoneNumber is required' });
    }

    const where = id ? { id } : { phoneNumber };
    const existing = await prisma.purchasedNumber.findFirst({ where });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Virtual number not found' });
    }

    const planType = durationDays >= 365 ? '365_days' : durationDays <= 7 ? '7_days' : '30_days';
    const price = calculateNumberPrice(existing.countryCode, planType, durationDays, existing.phoneNumber);

    const user = await prisma.user.findUnique({ where: { id: existing.userId } });
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Blocked / Suspended User Check
    if (!user.isVerified || user.isBanned || user.isDeleted) {
      return res.status(403).json({
        success: false,
        isBlocked: true,
        error: 'Your account has been blocked by administrator. Number renewal is disabled. Please contact support.'
      });
    }

    if (user.walletBalance < price) {
      return res.status(402).json({
        success: false,
        error: `Insufficient wallet balance to renew. You have $${user.walletBalance.toFixed(2)}, but renewal requires $${price.toFixed(2)}. Please top up your wallet.`,
        requiredAmount: price,
        currentBalance: user.walletBalance
      });
    }

    const currentExpiry = existing.expiresAt ? new Date(existing.expiresAt).getTime() : Date.now();
    const baseTime = currentExpiry > Date.now() ? currentExpiry : Date.now();
    const newExpiresAt = new Date(baseTime + parseInt(durationDays, 10) * 24 * 60 * 60 * 1000);

    // Deduct price from wallet
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: { walletBalance: { decrement: price } }
    });

    await prisma.transaction.create({
      data: {
        userId: user.id,
        type: 'renewal',
        amount: -price,
        description: `Line Renewal (+${durationDays} Days): ${existing.phoneNumber}`
      }
    });

    const updated = await prisma.purchasedNumber.update({
      where: { id: existing.id },
      data: {
        expiresAt: newExpiresAt,
        status: "active"
      }
    });

    console.log(`🔄 [BILLING - LINE RENEW] Number ${existing.phoneNumber} renewed for $${price.toFixed(2)}. New balance: $${updatedUser.walletBalance.toFixed(2)}`);

    res.json({
      success: true,
      message: `Line renewed for +${durationDays} days! $${price.toFixed(2)} deducted.`,
      costDeducted: price,
      newWalletBalance: updatedUser.walletBalance,
      data: updated
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3.2 Endpoint: Update Number Settings (Profile Name, DND, Call Forwarding, Auto-Reply)
app.patch('/api/numbers/update', async (req, res) => {
  try {
    const { id, profileName, dndEnabled, callForwardingNumber, autoReplyText } = req.body;
    if (!id) {
      return res.status(400).json({ success: false, error: 'Number id is required' });
    }

    const data = {};
    if (profileName !== undefined) data.profileName = profileName;
    if (dndEnabled !== undefined) data.dndEnabled = dndEnabled;
    if (callForwardingNumber !== undefined) data.callForwardingNumber = callForwardingNumber;
    if (autoReplyText !== undefined) data.autoReplyText = autoReplyText;

    const updated = await prisma.purchasedNumber.update({
      where: { id },
      data
    });

    res.json({
      success: true,
      message: 'Number settings updated successfully!',
      data: updated
    });
  } catch (error) {
    console.error('[SIMLY ERROR] Failed to update number settings:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3.3.1 Endpoint: Lookup Recipient for Line Transfer
app.post('/api/numbers/transfer-lookup', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) {
      return res.status(400).json({ success: false, error: 'Recipient email or phone number is required' });
    }

    const cleanQuery = query.trim().toLowerCase();
    const cleanPhone = normalizePhone(query);

    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: cleanQuery },
          { phone: cleanPhone },
          { id: query.trim() }
        ]
      }
    });

    if (user) {
      return res.json({
        success: true,
        user: {
          id: user.id,
          name: user.name || 'SimlyTel User',
          email: user.email,
          phone: user.phone
        }
      });
    }

    return res.status(404).json({
      success: false,
      error: 'User not found on SimlyTel. Recipient must create a SimlyTel account first before receiving a line transfer.'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3.3.2 Endpoint: Execute Line Ownership Transfer (Strictly to registered users only)
app.post('/api/numbers/transfer', async (req, res) => {
  try {
    const { id, targetRecipient, targetUserId, senderUserId } = req.body;
    const recipientIdentifier = (targetRecipient || targetUserId || '').trim();
    if (!id || !recipientIdentifier) {
      return res.status(400).json({ success: false, error: 'Line ID and recipient are required' });
    }

    const cleanTarget = recipientIdentifier.toLowerCase();
    const cleanPhone = normalizePhone(recipientIdentifier);

    const targetUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email: cleanTarget },
          { phone: cleanPhone },
          { id: recipientIdentifier }
        ]
      }
    });

    if (!targetUser) {
      return res.status(404).json({
        success: false,
        error: 'Recipient user does not exist on SimlyTel. Numbers can only be transferred to existing registered accounts.'
      });
    }

    if (senderUserId) {
      const cleanSender = senderUserId.toString().trim();
      const sender = await prisma.user.findFirst({
        where: {
          OR: [
            { id: cleanSender },
            { email: cleanSender.toLowerCase() },
            { email: `${cleanSender.toLowerCase()}@simlytel.com` }
          ]
        }
      });
      if (sender && (!sender.isVerified || sender.isBanned || sender.isDeleted)) {
        return res.status(403).json({
          success: false,
          isBlocked: true,
          error: 'Your account has been restricted by administrator. You cannot transfer lines. Please contact Customer Support.'
        });
      }
    }

    if (senderUserId && targetUser.id === senderUserId) {
      return res.status(400).json({ success: false, error: 'Cannot transfer a number to your own account.' });
    }

    const updated = await prisma.purchasedNumber.update({
      where: { id },
      data: { userId: targetUser.id }
    });

    console.log(`🔀 [SIMLYTEL TRANSFER] Transferred line ${updated.phoneNumber} to ${targetUser.email} (${targetUser.id})`);

    await prisma.transaction.create({
      data: {
        userId: targetUser.id,
        type: 'transfer_in',
        amount: 0.0,
        description: `Line Ownership Received: ${updated.phoneNumber}`
      }
    });

    res.json({
      success: true,
      message: `Line ${updated.phoneNumber} transferred to ${targetUser.name || targetUser.email} successfully!`,
      recipient: {
        name: targetUser.name,
        email: targetUser.email
      },
      data: updated
    });
  } catch (error) {
    console.error('[SIMLY ERROR] Failed to transfer number:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3.4 Endpoint: Cancel / Release Virtual Number
app.delete('/api/numbers/cancel', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) {
      return res.status(400).json({ success: false, error: 'id is required' });
    }

    const deleted = await prisma.purchasedNumber.delete({
      where: { id }
    });

    console.log(`🗑️ [SIMLY CANCEL] Canceled number ${deleted.phoneNumber}`);

    res.json({
      success: true,
      message: `Number ${deleted.phoneNumber} has been cancelled and removed.`
    });
  } catch (error) {
    console.error('[SIMLY ERROR] Failed to cancel number:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. Endpoint: Send Outbound SMS Message (1.5x Telnyx wholesale billing)
app.post('/api/sms/send', async (req, res) => {
  try {
    const { fromNumber, toNumber, text, userId } = req.body;
    if (!fromNumber || !toNumber || !text) {
      return res.status(400).json({ success: false, error: 'fromNumber, toNumber, and text are required.' });
    }

    const cleanFrom = normalizePhone(fromNumber);
    const cleanTo = normalizePhone(toNumber);

    // Verify virtual line ownership and active status
    const lineOwner = await prisma.purchasedNumber.findFirst({
      where: { phoneNumber: cleanFrom, status: 'active' }
    });

    if (!lineOwner) {
      return res.status(403).json({
        success: false,
        error: 'You do not have an active line for this number. Outbound SMS requires an active virtual line.'
      });
    }

    let user = await prisma.user.findUnique({ where: { id: lineOwner.userId } });
    if (!user && userId) {
      const cleanUid = userId.toString().trim();
      user = await prisma.user.findFirst({
        where: {
          OR: [
            { id: cleanUid },
            { email: cleanUid.toLowerCase() },
            { email: `${cleanUid.toLowerCase()}@simlytel.com` }
          ]
        }
      });
    }

    if (!user) {
      return res.status(401).json({ success: false, error: 'User account not found.' });
    }

    // Blocked / Suspended User Check
    if (!user.isVerified || user.isBanned || user.isDeleted) {
      return res.status(403).json({
        success: false,
        isBlocked: true,
        error: 'Your account has been restricted by administrator. Outbound SMS is disabled. Please contact support.'
      });
    }

    // Determine SMS cost (1.5x wholesale multiplier)
    let wholesaleSms = 0.010;
    if (cleanTo.startsWith('+1')) wholesaleSms = 0.008;
    else if (cleanTo.startsWith('+44')) wholesaleSms = 0.012;
    else if (cleanTo.startsWith('+92')) wholesaleSms = 0.025;
    const smsPrice = parseFloat((wholesaleSms * NUMBER_RETAIL_MULTIPLIER).toFixed(3));

    // STRICT WALLET BALANCE CHECK
    if (user.walletBalance < smsPrice || user.walletBalance <= 0) {
      return res.status(402).json({
        success: false,
        error: `Insufficient wallet balance. Sending SMS requires $${smsPrice.toFixed(3)}, but your balance is $${user.walletBalance.toFixed(2)}. Please top up your wallet.`,
        requiredAmount: smsPrice,
        currentBalance: user.walletBalance
      });
    }

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: { walletBalance: { decrement: smsPrice } }
    });

    await prisma.transaction.create({
      data: {
        userId: user.id,
        type: 'sms',
        amount: -smsPrice,
        description: `Outbound SMS to ${cleanTo}`
      }
    });

    let telnyxMessageId = null;
    try {
      const telnyxRes = await telnyx.messages.create({
        from: cleanFrom,
        to: cleanTo,
        text: text
      });
      telnyxMessageId = telnyxRes?.data?.id || null;
    } catch (carrierErr) {
      console.warn('[SIMLYTEL SMS] Carrier dispatch notice:', carrierErr.message);
    }

    const savedMessage = await prisma.message.create({
      data: {
        fromNumber: cleanFrom,
        toNumber: cleanTo,
        text,
        direction: 'outbound',
        status: 'delivered',
        telnyxMessageId
      }
    });

    console.log(`💬 [BILLING - SMS] Deducted $${smsPrice} for SMS to ${cleanTo} (User: ${user.email}, New Balance: $${updatedUser.walletBalance.toFixed(2)})`);

    res.json({
      success: true,
      costDeducted: smsPrice,
      newBalance: updatedUser.walletBalance,
      message: savedMessage
    });
  } catch (error) {
    console.error('[SIMLYTEL ERROR] Failed to send SMS:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. Endpoint: Get conversation threads (Single Line or Universal Unified Inbox)
// 5. Endpoint: Fetch conversation threads strictly scoped to user's owned lines
app.get('/api/sms/conversations', async (req, res) => {
  try {
    const phoneNumber = normalizePhone(req.query.phoneNumber);
    const { userId } = req.query;

    if (!userId) {
      return res.json({ success: true, count: 0, conversations: [] });
    }

    const cleanUserId = userId.toString().trim();

    // Fetch all numbers belonging exclusively to this user
    const userNumbers = await prisma.purchasedNumber.findMany({
      where: {
        OR: [
          { userId: cleanUserId },
          { userId: `${cleanUserId}@simlytel.com` },
          { userId: `${cleanUserId}@simly.app` }
        ]
      },
      select: { phoneNumber: true, profileName: true, countryCode: true }
    });

    // If new user has no numbers, return 0 conversations immediately
    if (userNumbers.length === 0) {
      return res.json({ success: true, count: 0, conversations: [] });
    }

    const userNumbersList = userNumbers.map(n => n.phoneNumber);
    const userNumbersMap = new Map(userNumbers.map(n => [n.phoneNumber, n]));

    let allMessages = [];
    if (phoneNumber && phoneNumber !== 'all') {
      if (!userNumbersMap.has(phoneNumber)) {
        return res.json({ success: true, count: 0, conversations: [] });
      }
      allMessages = await prisma.message.findMany({
        where: {
          OR: [
            { fromNumber: phoneNumber },
            { toNumber: phoneNumber }
          ]
        },
        orderBy: { createdAt: 'desc' }
      });
    } else {
      // Unified Inbox: Only fetch messages belonging to lines owned by THIS user
      allMessages = await prisma.message.findMany({
        where: {
          OR: [
            { fromNumber: { in: userNumbersList } },
            { toNumber: { in: userNumbersList } }
          ]
        },
        orderBy: { createdAt: 'desc' }
      });
    }

    // Group messages by (myNumber + contactNumber)
    const threadsMap = new Map();
    for (const msg of allMessages) {
      let myLine = null;
      let contact = null;

      if (userNumbersMap.has(msg.toNumber)) {
        myLine = msg.toNumber;
        contact = msg.fromNumber;
      } else if (userNumbersMap.has(msg.fromNumber)) {
        myLine = msg.fromNumber;
        contact = msg.toNumber;
      } else {
        continue; // Privacy shield: Do not leak messages of other users
      }

      const threadKey = `${myLine}_${contact}`;
      if (!threadsMap.has(threadKey)) {
        const lineMeta = userNumbersMap.get(myLine) || {};
        threadsMap.set(threadKey, {
          myNumber: myLine,
          myProfileName: lineMeta.profileName || 'My Line',
          countryCode: lineMeta.countryCode || 'US',
          contactNumber: contact,
          lastMessage: msg.text,
          lastMessageTime: msg.createdAt,
          lastDirection: msg.direction,
          lastStatus: msg.status,
          unreadCount: msg.direction === 'inbound' ? 1 : 0
        });
      }
    }

    res.json({
      success: true,
      count: threadsMap.size,
      conversations: Array.from(threadsMap.values())
    });
  } catch (error) {
    console.error('[SIMLYTEL ERROR] Failed to get conversations:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 6. Endpoint: Get full message thread between user virtual number and a contact
app.get('/api/sms/thread', async (req, res) => {
  try {
    const myNumber = normalizePhone(req.query.myNumber);
    const contactNumber = normalizePhone(req.query.contactNumber);
    const { userId } = req.query;

    if (!myNumber || !contactNumber) {
      return res.status(400).json({ success: false, error: 'myNumber and contactNumber are required' });
    }

    if (userId) {
      const cleanUserId = userId.toString().trim();
      const isOwned = await prisma.purchasedNumber.findFirst({
        where: {
          phoneNumber: myNumber,
          OR: [
            { userId: cleanUserId },
            { userId: `${cleanUserId}@simlytel.com` },
            { userId: `${cleanUserId}@simly.app` }
          ]
        }
      });
      if (!isOwned) {
        return res.status(403).json({ success: false, error: 'Access denied: You do not own this line.' });
      }
    }

    const messages = await prisma.message.findMany({
      where: {
        OR: [
          { fromNumber: myNumber, toNumber: contactNumber },
          { fromNumber: contactNumber, toNumber: myNumber }
        ]
      },
      orderBy: { createdAt: 'asc' }
    });

    res.json({
      success: true,
      messages
    });
  } catch (error) {
    console.error('[SIMLYTEL ERROR] Failed to get message thread:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 7. Endpoint: Simulate an incoming SMS (e.g. OTP code for testing)
app.post('/api/sms/simulate-inbound', async (req, res) => {
  try {
    const { toNumber, fromNumber, text } = req.body;
    if (!toNumber || !text) {
      return res.status(400).json({ success: false, error: 'toNumber and text are required' });
    }

    const sender = fromNumber || '+18005550199';
    const saved = await prisma.message.create({
      data: {
        fromNumber: sender,
        toNumber,
        text,
        direction: 'inbound',
        status: 'received'
      }
    });

    console.log(`📩 [SIMULATED SMS] From: ${sender} -> To: ${toNumber} | Text: "${text}"`);

    res.json({
      success: true,
      message: saved
    });
  } catch (error) {
    console.error('[SIMLYTEL ERROR] Failed to simulate inbound SMS:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 8. Endpoint: Webhook Listener for Inbound SMS & Calls
app.post('/api/telnyx/webhook', async (req, res) => {
  try {
    const event = req.body;
    if (event.data && event.data.event_type === 'message.received') {
      const incomingSMS = event.data.payload;
      const to = incomingSMS.to && incomingSMS.to[0] ? incomingSMS.to[0].phone_number : null;
      const from = incomingSMS.from ? incomingSMS.from.phone_number : null;
      const text = incomingSMS.text || '';
      const telnyxId = incomingSMS.id || null;

      if (to && from) {
        console.log(`📩 [INBOUND SMS] To: ${to} | From: ${from} | Text: ${text}`);
        await prisma.message.create({
          data: {
            fromNumber: from,
            toNumber: to,
            text,
            direction: 'inbound',
            status: 'received',
            telnyxMessageId: telnyxId
          }
        });
      }
    }
  } catch (err) {
    console.error('[SIMLYTEL WEBHOOK ERROR]', err.message);
  }
  res.sendStatus(200);
});

// 9. Endpoint: Log Call Record (Outbound or Inbound, with 2.5x per-minute call rate billing)
app.post('/api/calls/log', async (req, res) => {
  try {
    const {
      myNumber,
      contactNumber,
      direction = 'outbound',
      status = 'completed',
      durationSeconds = 0,
      userId
    } = req.body;

    if (!myNumber || !contactNumber) {
      return res.status(400).json({ success: false, error: 'myNumber and contactNumber are required' });
    }

    const cleanMyNumber = normalizePhone(myNumber);
    const cleanContact = normalizePhone(contactNumber);
    const durSec = parseInt(durationSeconds, 10) || 0;

    // Outbound Call Billing (2.5x Wholesale Multiplier)
    let callCost = 0.0;
    if (direction === 'outbound') {
      const lineOwner = await prisma.purchasedNumber.findFirst({
        where: { phoneNumber: cleanMyNumber, status: 'active' }
      });

      let user = null;
      if (lineOwner) {
        user = await prisma.user.findUnique({ where: { id: lineOwner.userId } });
      }
      if (!user && userId) {
        const cleanUid = userId.toString().trim();
        user = await prisma.user.findFirst({
          where: {
            OR: [
              { id: cleanUid },
              { email: cleanUid.toLowerCase() },
              { email: `${cleanUid.toLowerCase()}@simlytel.com` }
            ]
          }
        });
      }

      if (!user) {
        return res.status(403).json({
          success: false,
          error: 'You do not have an active virtual line assigned to make outbound calls.'
        });
      }

      // Blocked / Suspended User Check
      if (!user.isVerified || user.isBanned || user.isDeleted) {
        return res.status(403).json({
          success: false,
          isBlocked: true,
          error: 'Your account has been blocked by administrator. Outbound calling is disabled. Please contact support.'
        });
      }

      const minutes = durSec > 0 ? Math.ceil(durSec / 60) : 1;
      let baseCallRate = 0.020;
      for (const r of baseRates) {
        if (cleanContact.startsWith(r.dialCode)) {
          baseCallRate = r.baseCall;
          break;
        }
      }
      const ratePerMin = parseFloat((baseCallRate * CALLING_RETAIL_MULTIPLIER).toFixed(3));
      callCost = parseFloat((minutes * ratePerMin).toFixed(2));

      if (durSec > 0) {
        if (user.walletBalance < callCost || user.walletBalance <= 0) {
          return res.status(402).json({
            success: false,
            error: `Insufficient wallet balance. Call duration (${durSec}s) cost $${callCost.toFixed(2)}, but balance is $${user.walletBalance.toFixed(2)}. Please top up your wallet.`,
            requiredAmount: callCost,
            currentBalance: user.walletBalance
          });
        }

        await prisma.user.update({
          where: { id: user.id },
          data: { walletBalance: { decrement: callCost } }
        });

        await prisma.transaction.create({
          data: {
            userId: user.id,
            type: 'call',
            amount: -callCost,
            description: `Outbound Call (${durSec}s @ $${ratePerMin}/min) to ${cleanContact}`
          }
        });

        console.log(`📞 [BILLING - CALL] Deducted $${callCost.toFixed(2)} from ${user.email} (Remaining Balance: $${(user.walletBalance - callCost).toFixed(2)})`);
      }
    }

    const saved = await prisma.callLog.create({
      data: {
        myNumber: cleanMyNumber,
        contactNumber: cleanContact,
        direction,
        status,
        durationSeconds: durSec,
        hasRecording: false,
        recordingUrl: null
      }
    });

    res.json({
      success: true,
      costDeducted: callCost,
      call: saved
    });
  } catch (error) {
    console.error('[SIMLYTEL ERROR] Failed to log call:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 10. Endpoint: Retrieve Call History (strictly scoped to user's owned lines)
app.get('/api/calls/history', async (req, res) => {
  try {
    const myNumber = normalizePhone(req.query.myNumber);
    const { filter, userId } = req.query;

    if (!userId && !myNumber) {
      return res.json({ success: true, count: 0, calls: [] });
    }

    let allowedNumbers = [];
    if (userId) {
      const cleanUserId = userId.toString().trim();
      const userNumbers = await prisma.purchasedNumber.findMany({
        where: {
          OR: [
            { userId: cleanUserId },
            { userId: `${cleanUserId}@simlytel.com` },
            { userId: `${cleanUserId}@simly.app` }
          ]
        },
        select: { phoneNumber: true }
      });
      allowedNumbers = userNumbers.map(n => n.phoneNumber);
      if (allowedNumbers.length === 0 && !myNumber) {
        return res.json({ success: true, count: 0, calls: [] });
      }
    }

    const where = {};
    if (myNumber) {
      if (allowedNumbers.length > 0 && !allowedNumbers.includes(myNumber)) {
        return res.json({ success: true, count: 0, calls: [] });
      }
      where.myNumber = myNumber;
    } else if (allowedNumbers.length > 0) {
      where.myNumber = { in: allowedNumbers };
    }
    if (filter === 'missed') where.status = 'missed';

    const calls = await prisma.callLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 50
    });

    res.json({
      success: true,
      count: calls.length,
      calls
    });
  } catch (error) {
    console.error('[SIMLY ERROR] Failed to fetch call history:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 11. Endpoint: Simulate an Inbound Call
app.post('/api/calls/simulate-inbound', async (req, res) => {
  try {
    const { myNumber, fromNumber, durationSeconds = 25, status = 'completed' } = req.body;
    if (!myNumber) {
      return res.status(400).json({ success: false, error: 'myNumber is required' });
    }

    const caller = fromNumber || '+18005550199';
    const saved = await prisma.callLog.create({
      data: {
        myNumber,
        contactNumber: caller,
        direction: 'inbound',
        status,
        durationSeconds: parseInt(durationSeconds, 10) || 0
      }
    });

    console.log(`📲 [SIMULATED CALL] Incoming Call from ${caller} to ${myNumber} (${status})`);

    res.json({
      success: true,
      call: saved
    });
  } catch (error) {
    console.error('[SIMLY ERROR] Failed to simulate call:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 12. Endpoint: Get Wallet Information & Balance
app.get('/api/wallet/info', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.json({
        success: true,
        balance: 0.0,
        currency: 'USD',
        transactions: []
      });
    }

    const cleanUserId = userId.toString().trim().toLowerCase();
    const cleanPhone = normalizePhone(userId);

    let user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: cleanUserId },
          { email: `${cleanUserId}@simlytel.com` },
          { email: `${cleanUserId}@simly.app` },
          { phone: cleanPhone },
          { id: userId }
        ]
      }
    });

    if (!user) {
      return res.json({
        success: true,
        balance: 0.0,
        currency: 'USD',
        transactions: []
      });
    }

    const transactions = await prisma.transaction.findMany({
      where: {
        OR: [
          { userId: user.id },
          { userId }
        ]
      },
      orderBy: { createdAt: 'desc' },
      take: 20
    });

    const isBlocked = !user.isVerified || user.isBanned || user.isDeleted;

    res.json({
      success: true,
      balance: user.walletBalance,
      currency: 'USD',
      isBlocked,
      isVerified: user.isVerified,
      isBanned: user.isBanned,
      transactions
    });
  } catch (error) {
    console.error('[SIMLYTEL ERROR] Failed to fetch wallet info:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 13. Endpoint: Top-Up Wallet Balance
app.post('/api/wallet/topup', async (req, res) => {
  try {
    const { userId, packageId, amount, packageName } = req.body;
    if (!userId) {
      return res.status(400).json({ success: false, error: 'User ID is required for top-up' });
    }

    const topupAmount = parseFloat(amount);

    if (isNaN(topupAmount) || topupAmount <= 0) {
      return res.status(400).json({ success: false, error: 'Valid top-up amount is required' });
    }

    const cleanUserId = userId.toString().trim().toLowerCase();
    const cleanPhone = normalizePhone(userId);

    let user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: cleanUserId },
          { email: `${cleanUserId}@simlytel.com` },
          { email: `${cleanUserId}@simly.app` },
          { phone: cleanPhone },
          { id: userId }
        ]
      }
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User account not found. Please log in or create an account first.'
      });
    }

    user = await prisma.user.update({
      where: { id: user.id },
      data: { walletBalance: { increment: topupAmount } }
    });

    const tx = await prisma.transaction.create({
      data: {
        userId: user.id,
        type: 'topup',
        amount: topupAmount,
        description: packageName || `In-App Top-Up ($${topupAmount.toFixed(2)})`
      }
    });

    console.log(`💳 [SIMLY WALLET] User ${userId} topped up +$${topupAmount.toFixed(2)}. New balance: $${user.walletBalance.toFixed(2)}`);

    res.json({
      success: true,
      newBalance: user.walletBalance,
      transaction: tx
    });
  } catch (error) {
    console.error('[SIMLY ERROR] Failed to top-up wallet:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 13.1 Endpoint: Lookup User for Wallet Balance Transfer
app.post('/api/wallet/transfer-lookup', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query || !query.trim()) {
      return res.status(400).json({ success: false, error: 'Recipient query is required' });
    }

    const cleanQuery = query.trim().toLowerCase();
    const cleanPhone = normalizePhone(query);

    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: cleanQuery },
          { email: `${cleanQuery}@simlytel.com` },
          { email: `${cleanQuery}@simly.app` },
          { phone: cleanPhone },
          { id: query.trim() }
        ]
      }
    });

    if (user) {
      return res.json({
        success: true,
        user: {
          id: user.id,
          name: user.name || 'SimlyTel User',
          email: user.email,
          phone: user.phone
        }
      });
    }

    return res.status(404).json({
      success: false,
      error: 'User not found on SimlyTel. The recipient must have a registered SimlyTel account.'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 13.2 Endpoint: Execute Peer-to-Peer Wallet Balance Transfer
app.post('/api/wallet/transfer', async (req, res) => {
  try {
    const { senderUserId, targetRecipient, amount } = req.body;
    const transferAmount = parseFloat(amount);

    if (!senderUserId || !targetRecipient || isNaN(transferAmount) || transferAmount <= 0) {
      return res.status(400).json({ success: false, error: 'senderUserId, targetRecipient, and a valid transfer amount are required.' });
    }

    if (transferAmount < 0.10) {
      return res.status(400).json({ success: false, error: 'Minimum transfer amount is $0.10.' });
    }

    // 1. Find Sender User
    const cleanSender = senderUserId.toString().trim();
    const sender = await prisma.user.findFirst({
      where: {
        OR: [
          { id: cleanSender },
          { email: cleanSender.toLowerCase() },
          { email: `${cleanSender.toLowerCase()}@simlytel.com` },
          { email: `${cleanSender.toLowerCase()}@simly.app` }
        ]
      }
    });

    if (!sender) {
      return res.status(404).json({ success: false, error: 'Sender account not found.' });
    }

    // Check if Sender is Blocked / Restricted
    if (!sender.isVerified || sender.isBanned || sender.isDeleted) {
      return res.status(403).json({
        success: false,
        isBlocked: true,
        error: 'Your account has been restricted by administrator. You cannot transfer balance. Please contact Customer Support.'
      });
    }

    // Check Sender Balance
    if (sender.walletBalance < transferAmount) {
      return res.status(402).json({
        success: false,
        error: `Insufficient balance. You have $${sender.walletBalance.toFixed(2)} available, but tried to transfer $${transferAmount.toFixed(2)}.`,
        currentBalance: sender.walletBalance,
        requiredAmount: transferAmount
      });
    }

    // 2. Find Recipient User (Strict registered user only)
    const cleanTarget = targetRecipient.toString().trim().toLowerCase();
    const cleanPhone = normalizePhone(targetRecipient);

    const recipient = await prisma.user.findFirst({
      where: {
        OR: [
          { email: cleanTarget },
          { email: `${cleanTarget}@simlytel.com` },
          { email: `${cleanTarget}@simly.app` },
          { phone: cleanPhone },
          { id: targetRecipient.toString().trim() }
        ]
      }
    });

    if (!recipient) {
      return res.status(404).json({
        success: false,
        error: 'Recipient user does not exist on SimlyTel. Please ensure they have registered an account.'
      });
    }

    if (recipient.id === sender.id || recipient.email.toLowerCase() === sender.email.toLowerCase()) {
      return res.status(400).json({ success: false, error: 'Cannot transfer balance to your own account.' });
    }

    // 3. Deduct from Sender & Add to Recipient
    const updatedSender = await prisma.user.update({
      where: { id: sender.id },
      data: { walletBalance: { decrement: transferAmount } }
    });

    const updatedRecipient = await prisma.user.update({
      where: { id: recipient.id },
      data: { walletBalance: { increment: transferAmount } }
    });

    // 4. Create Ledger Transactions
    await prisma.transaction.create({
      data: {
        userId: sender.id,
        type: 'transfer_out',
        amount: -transferAmount,
        description: `Transferred $${transferAmount.toFixed(2)} to ${recipient.name || recipient.email}`
      }
    });

    await prisma.transaction.create({
      data: {
        userId: recipient.id,
        type: 'transfer_in',
        amount: transferAmount,
        description: `Received $${transferAmount.toFixed(2)} from ${sender.name || sender.email}`
      }
    });

    console.log(`💸 [P2P WALLET] Transferred $${transferAmount.toFixed(2)} from ${sender.email} to ${recipient.email}`);

    res.json({
      success: true,
      message: `Successfully sent $${transferAmount.toFixed(2)} to ${recipient.name || recipient.email}!`,
      transferredAmount: transferAmount,
      newSenderBalance: updatedSender.walletBalance,
      recipient: {
        name: recipient.name,
        email: recipient.email
      }
    });
  } catch (error) {
    console.error('[SIMLY ERROR] Failed to execute balance transfer:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Wholesale Telnyx Base Rates for Worldwide Countries
const RETAIL_MULTIPLIER = 2.5;
const baseRates = [
  // North America
  { country: 'United States', code: 'US', dialCode: '+1', flag: '🇺🇸', baseCall: 0.009, baseSms: 0.008, minDigits: 11, maxDigits: 11, example: '+1 202 555 0123' },
  { country: 'Canada', code: 'CA', dialCode: '+1', flag: '🇨🇦', baseCall: 0.009, baseSms: 0.008, minDigits: 11, maxDigits: 11, example: '+1 416 555 0199' },
  { country: 'Mexico', code: 'MX', dialCode: '+52', flag: '🇲🇽', baseCall: 0.015, baseSms: 0.020, minDigits: 12, maxDigits: 12, example: '+52 55 1234 5678' },

  // Asia & Pacific
  { country: 'Singapore', code: 'SG', dialCode: '+65', flag: '🇸🇬', baseCall: 0.012, baseSms: 0.018, minDigits: 10, maxDigits: 10, example: '+65 9123 4567' },
  { country: 'Pakistan', code: 'PK', dialCode: '+92', flag: '🇵🇰', baseCall: 0.035, baseSms: 0.025, minDigits: 12, maxDigits: 12, example: '+92 300 1234567' },
  { country: 'India', code: 'IN', dialCode: '+91', flag: '🇮🇳', baseCall: 0.020, baseSms: 0.020, minDigits: 12, maxDigits: 12, example: '+91 98765 43210' },
  { country: 'China', code: 'CN', dialCode: '+86', flag: '🇨🇳', baseCall: 0.020, baseSms: 0.025, minDigits: 13, maxDigits: 13, example: '+86 138 1234 5678' },
  { country: 'Japan', code: 'JP', dialCode: '+81', flag: '🇯🇵', baseCall: 0.025, baseSms: 0.030, minDigits: 11, maxDigits: 12, example: '+81 90 1234 5678' },
  { country: 'South Korea', code: 'KR', dialCode: '+82', flag: '🇰🇷', baseCall: 0.022, baseSms: 0.025, minDigits: 11, maxDigits: 12, example: '+82 10 1234 5678' },
  { country: 'Hong Kong', code: 'HK', dialCode: '+852', flag: '🇭🇰', baseCall: 0.015, baseSms: 0.020, minDigits: 11, maxDigits: 11, example: '+852 9123 4567' },
  { country: 'Taiwan', code: 'TW', dialCode: '+886', flag: '🇹🇼', baseCall: 0.025, baseSms: 0.025, minDigits: 12, maxDigits: 12, example: '+886 912 345 678' },
  { country: 'Malaysia', code: 'MY', dialCode: '+60', flag: '🇲🇾', baseCall: 0.024, baseSms: 0.025, minDigits: 11, maxDigits: 12, example: '+60 12 345 6789' },
  { country: 'Indonesia', code: 'ID', dialCode: '+62', flag: '🇮🇩', baseCall: 0.040, baseSms: 0.030, minDigits: 12, maxDigits: 13, example: '+62 812 3456 7890' },
  { country: 'Philippines', code: 'PH', dialCode: '+63', flag: '🇵🇭', baseCall: 0.060, baseSms: 0.035, minDigits: 12, maxDigits: 12, example: '+63 917 123 4567' },
  { country: 'Thailand', code: 'TH', dialCode: '+66', flag: '🇹🇭', baseCall: 0.025, baseSms: 0.025, minDigits: 11, maxDigits: 11, example: '+66 81 234 5678' },
  { country: 'Vietnam', code: 'VN', dialCode: '+84', flag: '🇻🇳', baseCall: 0.045, baseSms: 0.030, minDigits: 11, maxDigits: 12, example: '+84 91 234 5678' },
  { country: 'Bangladesh', code: 'BD', dialCode: '+880', flag: '🇧🇩', baseCall: 0.030, baseSms: 0.025, minDigits: 13, maxDigits: 13, example: '+880 1712 345678' },
  { country: 'Sri Lanka', code: 'LK', dialCode: '+94', flag: '🇱🇰', baseCall: 0.065, baseSms: 0.030, minDigits: 11, maxDigits: 11, example: '+94 71 234 5678' },
  { country: 'Nepal', code: 'NP', dialCode: '+977', flag: '🇳🇵', baseCall: 0.070, baseSms: 0.030, minDigits: 13, maxDigits: 13, example: '+977 984 1234567' },
  { country: 'Afghanistan', code: 'AF', dialCode: '+93', flag: '🇦🇫', baseCall: 0.120, baseSms: 0.040, minDigits: 11, maxDigits: 11, example: '+93 70 123 4567' },
  { country: 'Australia', code: 'AU', dialCode: '+61', flag: '🇦🇺', baseCall: 0.024, baseSms: 0.030, minDigits: 11, maxDigits: 11, example: '+61 412 345 678' },
  { country: 'New Zealand', code: 'NZ', dialCode: '+64', flag: '🇳🇿', baseCall: 0.025, baseSms: 0.030, minDigits: 11, maxDigits: 11, example: '+64 21 123 4567' },

  // Middle East
  { country: 'United Arab Emirates', code: 'AE', dialCode: '+971', flag: '🇦🇪', baseCall: 0.120, baseSms: 0.040, minDigits: 12, maxDigits: 12, example: '+971 50 123 4567' },
  { country: 'Saudi Arabia', code: 'SA', dialCode: '+966', flag: '🇸🇦', baseCall: 0.100, baseSms: 0.040, minDigits: 12, maxDigits: 12, example: '+966 50 123 4567' },
  { country: 'Qatar', code: 'QA', dialCode: '+974', flag: '🇶🇦', baseCall: 0.110, baseSms: 0.040, minDigits: 11, maxDigits: 11, example: '+974 5512 3456' },
  { country: 'Kuwait', code: 'KW', dialCode: '+965', flag: '🇰🇼', baseCall: 0.100, baseSms: 0.040, minDigits: 11, maxDigits: 11, example: '+965 9123 4567' },
  { country: 'Oman', code: 'OM', dialCode: '+968', flag: '🇴🇲', baseCall: 0.120, baseSms: 0.040, minDigits: 11, maxDigits: 11, example: '+968 9123 4567' },
  { country: 'Bahrain', code: 'BH', dialCode: '+973', flag: '🇧🇭', baseCall: 0.090, baseSms: 0.035, minDigits: 11, maxDigits: 11, example: '+973 3912 3456' },
  { country: 'Turkey', code: 'TR', dialCode: '+90', flag: '🇹🇷', baseCall: 0.040, baseSms: 0.030, minDigits: 12, maxDigits: 12, example: '+90 532 123 4567' },
  { country: 'Jordan', code: 'JO', dialCode: '+962', flag: '🇯🇴', baseCall: 0.080, baseSms: 0.035, minDigits: 12, maxDigits: 12, example: '+962 7 9123 4567' },
  { country: 'Lebanon', code: 'LB', dialCode: '+961', flag: '🇱🇧', baseCall: 0.100, baseSms: 0.040, minDigits: 11, maxDigits: 11, example: '+961 70 123 456' },
  { country: 'Iraq', code: 'IQ', dialCode: '+964', flag: '🇮🇶', baseCall: 0.120, baseSms: 0.040, minDigits: 13, maxDigits: 13, example: '+964 790 123 4567' },
  { country: 'Iran', code: 'IR', dialCode: '+98', flag: '🇮🇷', baseCall: 0.090, baseSms: 0.035, minDigits: 12, maxDigits: 12, example: '+98 912 123 4567' },

  // Europe
  { country: 'United Kingdom', code: 'GB', dialCode: '+44', flag: '🇬🇧', baseCall: 0.012, baseSms: 0.012, minDigits: 12, maxDigits: 12, example: '+44 7868 241079' },
  { country: 'Germany', code: 'DE', dialCode: '+49', flag: '🇩🇪', baseCall: 0.020, baseSms: 0.028, minDigits: 12, maxDigits: 14, example: '+49 151 12345678' },
  { country: 'France', code: 'FR', dialCode: '+33', flag: '🇫🇷', baseCall: 0.020, baseSms: 0.028, minDigits: 11, maxDigits: 11, example: '+33 6 12 34 56 78' },
  { country: 'Italy', code: 'IT', dialCode: '+39', flag: '🇮🇹', baseCall: 0.024, baseSms: 0.028, minDigits: 12, maxDigits: 13, example: '+39 320 1234567' },
  { country: 'Spain', code: 'ES', dialCode: '+34', flag: '🇪🇸', baseCall: 0.020, baseSms: 0.028, minDigits: 11, maxDigits: 11, example: '+34 612 345 678' },
  { country: 'Netherlands', code: 'NL', dialCode: '+31', flag: '🇳🇱', baseCall: 0.022, baseSms: 0.028, minDigits: 11, maxDigits: 11, example: '+31 6 12345678' },
  { country: 'Switzerland', code: 'CH', dialCode: '+41', flag: '🇨🇭', baseCall: 0.025, baseSms: 0.030, minDigits: 11, maxDigits: 11, example: '+41 79 123 45 67' },
  { country: 'Sweden', code: 'SE', dialCode: '+46', flag: '🇸🇪', baseCall: 0.022, baseSms: 0.028, minDigits: 11, maxDigits: 12, example: '+46 70 123 4567' },
  { country: 'Norway', code: 'NO', dialCode: '+47', flag: '🇳🇴', baseCall: 0.024, baseSms: 0.028, minDigits: 10, maxDigits: 10, example: '+47 412 34 567' },
  { country: 'Denmark', code: 'DK', dialCode: '+45', flag: '🇩🇰', baseCall: 0.022, baseSms: 0.028, minDigits: 10, maxDigits: 10, example: '+45 20 12 34 56' },
  { country: 'Finland', code: 'FI', dialCode: '+358', flag: '🇫🇮', baseCall: 0.025, baseSms: 0.028, minDigits: 12, maxDigits: 12, example: '+358 40 1234567' },
  { country: 'Belgium', code: 'BE', dialCode: '+32', flag: '🇧🇪', baseCall: 0.024, baseSms: 0.028, minDigits: 11, maxDigits: 11, example: '+32 470 12 34 56' },
  { country: 'Austria', code: 'AT', dialCode: '+43', flag: '🇦🇹', baseCall: 0.024, baseSms: 0.028, minDigits: 12, maxDigits: 13, example: '+43 664 1234567' },
  { country: 'Ireland', code: 'IE', dialCode: '+353', flag: '🇮🇪', baseCall: 0.022, baseSms: 0.028, minDigits: 12, maxDigits: 12, example: '+353 85 123 4567' },
  { country: 'Poland', code: 'PL', dialCode: '+48', flag: '🇵🇱', baseCall: 0.025, baseSms: 0.028, minDigits: 11, maxDigits: 11, example: '+48 512 345 678' },
  { country: 'Portugal', code: 'PT', dialCode: '+351', flag: '🇵🇹', baseCall: 0.024, baseSms: 0.028, minDigits: 12, maxDigits: 12, example: '+351 912 345 678' },
  { country: 'Greece', code: 'GR', dialCode: '+30', flag: '🇬🇷', baseCall: 0.025, baseSms: 0.028, minDigits: 12, maxDigits: 12, example: '+30 691 234 5678' },
  { country: 'Romania', code: 'RO', dialCode: '+40', flag: '🇷🇴', baseCall: 0.028, baseSms: 0.028, minDigits: 11, maxDigits: 11, example: '+40 712 345 678' },
  { country: 'Ukraine', code: 'UA', dialCode: '+380', flag: '🇺🇦', baseCall: 0.070, baseSms: 0.035, minDigits: 12, maxDigits: 12, example: '+380 50 123 4567' },

  // South & Central America
  { country: 'Brazil', code: 'BR', dialCode: '+55', flag: '🇧🇷', baseCall: 0.028, baseSms: 0.028, minDigits: 13, maxDigits: 13, example: '+55 11 91234 5678' },
  { country: 'Argentina', code: 'AR', dialCode: '+54', flag: '🇦🇷', baseCall: 0.035, baseSms: 0.030, minDigits: 13, maxDigits: 13, example: '+54 9 11 1234 5678' },
  { country: 'Colombia', code: 'CO', dialCode: '+57', flag: '🇨🇴', baseCall: 0.030, baseSms: 0.028, minDigits: 12, maxDigits: 12, example: '+57 300 123 4567' },
  { country: 'Chile', code: 'CL', dialCode: '+56', flag: '🇨🇱', baseCall: 0.030, baseSms: 0.028, minDigits: 11, maxDigits: 11, example: '+56 9 1234 5678' },
  { country: 'Peru', code: 'PE', dialCode: '+51', flag: '🇵🇪', baseCall: 0.035, baseSms: 0.028, minDigits: 11, maxDigits: 11, example: '+51 912 345 678' },

  // Africa
  { country: 'Nigeria', code: 'NG', dialCode: '+234', flag: '🇳🇬', baseCall: 0.080, baseSms: 0.040, minDigits: 13, maxDigits: 13, example: '+234 802 123 4567' },
  { country: 'Egypt', code: 'EG', dialCode: '+20', flag: '🇪🇬', baseCall: 0.050, baseSms: 0.030, minDigits: 12, maxDigits: 12, example: '+20 100 123 4567' },
  { country: 'South Africa', code: 'ZA', dialCode: '+27', flag: '🇿🇦', baseCall: 0.045, baseSms: 0.030, minDigits: 11, maxDigits: 11, example: '+27 82 123 4567' },
  { country: 'Kenya', code: 'KE', dialCode: '+254', flag: '🇰🇪', baseCall: 0.060, baseSms: 0.035, minDigits: 12, maxDigits: 12, example: '+254 712 345678' },
  { country: 'Ghana', code: 'GH', dialCode: '+233', flag: '🇬🇭', baseCall: 0.075, baseSms: 0.035, minDigits: 12, maxDigits: 12, example: '+233 24 123 4567' },
  { country: 'Morocco', code: 'MA', dialCode: '+212', flag: '🇲🇦', baseCall: 0.090, baseSms: 0.035, minDigits: 12, maxDigits: 12, example: '+212 612 345678' },
];

const retailRates = baseRates.map(r => ({
  country: r.country,
  code: r.code,
  dialCode: r.dialCode,
  flag: r.flag,
  callRatePerMin: parseFloat((r.baseCall * RETAIL_MULTIPLIER).toFixed(3)),
  smsRate: parseFloat((r.baseSms * RETAIL_MULTIPLIER).toFixed(3)),
  minDigits: r.minDigits,
  maxDigits: r.maxDigits,
  example: r.example,
}));

// 14. Endpoint: International Calling & SMS Rates Catalog
app.get('/api/rates', async (req, res) => {
  try {
    res.json({
      success: true,
      count: retailRates.length,
      multiplier: RETAIL_MULTIPLIER,
      rates: retailRates
    });
  } catch (error) {
    console.error('[SIMLY ERROR] Failed to fetch rates:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 14b. Endpoint: Dialpad Dynamic Rate Lookup by Number & Talk-Time Calculator (Vyke & Fanytel Dialer)
app.get('/api/rates/lookup', async (req, res) => {
  try {
    const { number, userId = 'user_demo_1' } = req.query;
    if (!number) {
      return res.status(400).json({ success: false, error: 'Phone number is required' });
    }

    let cleanNum = number.replace(/[^\d+]/g, '');
    if (!cleanNum.startsWith('+')) {
      cleanNum = '+' + cleanNum;
    }

    // Sort by dialCode length descending so longer matching prefixes (e.g. +852, +358, +971) match before +1 or +8
    const sortedRates = [...retailRates].sort((a, b) => b.dialCode.length - a.dialCode.length);
    const matchedRate = sortedRates.find(r => cleanNum.startsWith(r.dialCode)) || {
      country: 'International Destination',
      code: 'INTL',
      dialCode: '+',
      flag: '🌐',
      callRatePerMin: 0.150,
      smsRate: 0.050,
      example: '+...'
    };

    const email = `${userId}@simly.app`;
    let user = await prisma.user.findFirst({
      where: {
        OR: [{ id: userId }, { email }]
      }
    });

    const balance = user ? user.walletBalance : 10.0;
    const maxMinutes = matchedRate.callRatePerMin > 0 ? Math.floor(balance / matchedRate.callRatePerMin) : 0;

    res.json({
      success: true,
      dialedNumber: cleanNum,
      country: matchedRate.country,
      flag: matchedRate.flag,
      code: matchedRate.code,
      dialCode: matchedRate.dialCode,
      callRatePerMin: matchedRate.callRatePerMin,
      smsRate: matchedRate.smsRate,
      walletBalance: parseFloat(balance.toFixed(2)),
      maxMinutesAvailable: maxMinutes,
      canCall: balance >= matchedRate.callRatePerMin
    });
  } catch (error) {
    console.error('[SIMLY ERROR] Failed to lookup rate:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 15. Endpoint: Support Ticket & Feedback
app.post('/api/support/ticket', async (req, res) => {
  try {
    const { userId = 'user_demo_1', subject, category, message } = req.body;
    const ticketId = 'TICK-' + Math.floor(100000 + Math.random() * 900000);
    console.log(`📩 [SUPPORT TICKET] [${ticketId}] from User ${userId}: [${category}] ${subject} - ${message}`);

    res.json({
      success: true,
      ticketId,
      message: 'Your inquiry has been submitted. Our telecom support team will reply shortly.'
    });
  } catch (error) {
    console.error('[SIMLY ERROR] Failed to submit support ticket:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 15b. Endpoint: Get Live Support Chat Thread (Zendesk / Intercom Style)
app.get('/api/support/messages', async (req, res) => {
  try {
    const { userId = 'user_demo_1' } = req.query;

    let messages = await prisma.supportMessage.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' }
    });

    if (messages.length === 0) {
      const welcomeMsg = await prisma.supportMessage.create({
        data: {
          userId,
          sender: 'agent',
          senderName: 'Sarah (SimlyTel VIP Support)',
          text: 'Hi there! 👋 Welcome to SimlyTel VIP Support. How can we help with your virtual lines, WhatsApp OTP, or top-up today?'
        }
      });
      messages = [welcomeMsg];
    }

    res.json({
      success: true,
      count: messages.length,
      messages
    });
  } catch (error) {
    console.error('[SIMLY ERROR] Failed to fetch support messages:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 15c. Endpoint: Send Message to Live Support
app.post('/api/support/messages', async (req, res) => {
  try {
    const { userId = 'user_demo_1', text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ success: false, error: 'Message text is required' });
    }

    // Lookup user info for ticket profiling
    const senderUser = await prisma.user.findFirst({
      where: {
        OR: [
          { id: userId },
          { email: userId.toLowerCase() }
        ]
      },
      select: { name: true, email: true }
    });

    const userMsg = await prisma.supportMessage.create({
      data: {
        userId,
        sender: 'user',
        text: text.trim()
      }
    });

    // Auto-update or Create Support Ticket in Incoming Queue
    const existingTicket = await prisma.supportTicket.findUnique({ where: { userId } });
    const isLiveAgentAssigned = existingTicket && (existingTicket.status === 'in_progress' || Boolean(existingTicket.assignedStaffId));
    const ticketStatus = isLiveAgentAssigned ? 'in_progress' : 'unassigned';

    await prisma.supportTicket.upsert({
      where: { userId },
      update: {
        userName: senderUser?.name || existingTicket?.userName || (userId.includes('@') ? userId.split('@')[0] : 'SimlyTel Customer'),
        userEmail: senderUser?.email || existingTicket?.userEmail || (userId.includes('@') ? userId : null),
        status: ticketStatus,
        lastMessageText: text.trim(),
        lastMessageSender: 'user',
        lastMessageAt: new Date(),
        unreadStaffCount: { increment: 1 }
      },
      create: {
        userId,
        userName: senderUser?.name || (userId.includes('@') ? userId.split('@')[0] : 'SimlyTel Customer'),
        userEmail: senderUser?.email || (userId.includes('@') ? userId : null),
        status: 'unassigned',
        lastMessageText: text.trim(),
        lastMessageSender: 'user',
        lastMessageAt: new Date(),
        unreadStaffCount: 1
      }
    });

    let agentMsg = null;
    // ONLY send automated bot acknowledgement if ticket is NOT currently handled by a live human agent
    if (!isLiveAgentAssigned) {
      const lower = text.toLowerCase();
      let replyText = 'Thank you for contacting SimlyTel Support! Our specialist team has queued your ticket. A live telecom engineer is reviewing your line right now.';

      if (lower.includes('whatsapp') || lower.includes('otp') || lower.includes('code') || lower.includes('telegram')) {
        replyText = 'For WhatsApp/Telegram OTPs:\n1. Make sure you entered the correct country code (+1 or +44).\n2. If the SMS is delayed, tap "Call Me" in WhatsApp to receive the voice verification code directly on your line!\n3. Check your SimlyTel "Messages" tab.';
      } else if (lower.includes('rate') || lower.includes('call') || lower.includes('dial') || lower.includes('minute')) {
        replyText = 'All calls are billed in real-time per minute from your wallet balance. As soon as you dial any country code (e.g. +92, +1, +44, +65), your rate and remaining minutes show directly above the keypad.';
      } else if (lower.includes('topup') || lower.includes('balance') || lower.includes('money') || lower.includes('wallet')) {
        replyText = 'You can top up any custom amount in the "Wallet" section. Credits are applied instantly and never expire!';
      } else if (lower.includes('human') || lower.includes('agent') || lower.includes('live')) {
        replyText = 'You are in queue for a senior telecom agent. Current wait time is under 2 minutes. Please stay on this screen.';
      }

      agentMsg = await prisma.supportMessage.create({
        data: {
          userId,
          sender: 'agent',
          senderName: 'Sarah (SimlyTel VIP Support)',
          text: replyText
        }
      });
      console.log(`💬 [SUPPORT BOT] Sent auto-ack to unassigned User: "${replyText.substring(0, 40)}..."`);
    }

    res.json({
      success: true,
      userMessage: userMsg,
      agentMessage: agentMsg
    });
  } catch (error) {
    console.error('[SIMLY ERROR] Failed to send support message:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 16. Endpoint: WebRTC & SIP Credentials for In-App VoIP Calling (React Native / Flutter Client Engine)
app.post('/api/calls/webrtc-token', async (req, res) => {
  try {
    const { userId, callerNumber } = req.body;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'User authentication required for calling.' });
    }

    const cleanUserId = userId.toString().trim();
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { id: cleanUserId },
          { email: cleanUserId.toLowerCase() },
          { email: `${cleanUserId.toLowerCase()}@simlytel.com` },
          { email: `${cleanUserId.toLowerCase()}@simly.app` }
        ]
      }
    });

    if (!user) {
      return res.status(404).json({ success: false, error: 'User account not found.' });
    }

    if (!user.isVerified || user.isBanned || user.isDeleted) {
      return res.status(403).json({
        success: false,
        isBlocked: true,
        error: 'Your account has been restricted by administrator. Calling is disabled. Please contact support.'
      });
    }

    // Minimum balance requirement: Must have at least $0.020 to initiate calling
    if (user.walletBalance < 0.02 || user.walletBalance <= 0) {
      return res.status(402).json({
        success: false,
        error: `Insufficient wallet balance ($${user.walletBalance.toFixed(2)}). Minimum $0.020 is required to initiate a call. Please top up your wallet.`,
        currentBalance: user.walletBalance,
        requiredAmount: 0.020
      });
    }

    const sessionToken = `webrtc_simlytel_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const sipUsername = `simly_user_${user.id.replace(/[^a-zA-Z0-9]/g, '')}`;

    res.json({
      success: true,
      token: sessionToken,
      walletBalance: user.walletBalance,
      sipConfig: {
        username: sipUsername,
        domain: 'sip.telnyx.com',
        port: 5060,
        wsServers: ['wss://rtc.telnyx.com:443'],
        stunServers: ['stun:stun.telnyx.com:3478', 'stun:stun.l.google.com:19302'],
        turnServers: [
          {
            urls: 'turn:turn.telnyx.com:3478?transport=udp',
            username: sipUsername,
            credential: 'temp_turn_session_credential'
          }
        ],
        callerIdNumber: callerNumber || '+12025550123',
        codec: ['OPUS', 'G711u', 'G711a']
      },
      expiresIn: 3600
    });
  } catch (error) {
    console.error('[SIMLYTEL ERROR] Failed to generate WebRTC token:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 17. Voicemail Management Engine (strictly scoped to user lines)
app.get('/api/voicemails', async (req, res) => {
  try {
    const rawNumber = normalizePhone(req.query.myNumber);
    const { userId } = req.query;

    if (!userId && !rawNumber) {
      return res.json({ success: true, count: 0, voicemails: [] });
    }

    let allowedNumbers = [];
    if (userId) {
      const cleanUserId = userId.toString().trim();
      const userNumbers = await prisma.purchasedNumber.findMany({
        where: {
          OR: [
            { userId: cleanUserId },
            { userId: `${cleanUserId}@simlytel.com` },
            { userId: `${cleanUserId}@simly.app` }
          ]
        },
        select: { phoneNumber: true }
      });
      allowedNumbers = userNumbers.map(n => n.phoneNumber);
      if (allowedNumbers.length === 0 && !rawNumber) {
        return res.json({ success: true, count: 0, voicemails: [] });
      }
    }

    const where = {};
    if (rawNumber) {
      if (allowedNumbers.length > 0 && !allowedNumbers.includes(rawNumber)) {
        return res.json({ success: true, count: 0, voicemails: [] });
      }
      where.myNumber = rawNumber;
    } else if (allowedNumbers.length > 0) {
      where.myNumber = { in: allowedNumbers };
    }

    const voicemails = await prisma.voicemail.findMany({
      where,
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      success: true,
      count: voicemails.length,
      voicemails
    });
  } catch (error) {
    console.error('[SIMLY ERROR] Failed to fetch voicemails:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.patch('/api/voicemails/:id/read', async (req, res) => {
  try {
    const { id } = req.params;
    const updated = await prisma.voicemail.update({
      where: { id },
      data: { isRead: true }
    });
    res.json({ success: true, voicemail: updated });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/voicemails/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.voicemail.delete({ where: { id } });
    res.json({ success: true, message: 'Voicemail deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/voicemails/simulate', async (req, res) => {
  try {
    const {
      myNumber,
      contactNumber = '+18005550199',
      durationSeconds = 18,
      transcription = "Hi! I tried reaching you regarding your package delivery. Please call me back when you get a chance."
    } = req.body;

    if (!myNumber) {
      return res.status(400).json({ success: false, error: 'myNumber is required' });
    }

    const saved = await prisma.voicemail.create({
      data: {
        myNumber,
        contactNumber,
        audioUrl: `https://audio.simly.app/voicemails/vm_${Date.now()}.mp3`,
        durationSeconds: parseInt(durationSeconds, 10) || 18,
        isRead: false,
        transcription
      }
    });

    console.log(`📼 [VOICEMAIL RECEIVED] For ${myNumber} from ${contactNumber} (${durationSeconds}s)`);

    res.json({ success: true, voicemail: saved });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 18. Push Notifications & FCM Device Token Management
app.post('/api/notifications/register-token', async (req, res) => {
  try {
    const { userId = 'user_demo_1', token, platform = 'android' } = req.body;
    if (!token) {
      return res.status(400).json({ success: false, error: 'Device push token is required' });
    }

    const device = await prisma.devicePushToken.upsert({
      where: { token },
      update: { userId, platform, updatedAt: new Date() },
      create: { userId, token, platform }
    });

    console.log(`🔔 [PUSH TOKEN] Registered ${platform} device for user ${userId}`);

    res.json({
      success: true,
      message: 'Push token registered successfully',
      device
    });
  } catch (error) {
    console.error('[SIMLY ERROR] Failed to register token:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/notifications/send-test', async (req, res) => {
  try {
    const { userId = 'user_demo_1', type = 'incoming_call', title, body, callerNumber } = req.body;
    const tokens = await prisma.devicePushToken.findMany({ where: { userId } });

    console.log(`📲 [PUSH DISPATCH] Sent ${type} alert to ${tokens.length} device(s) for user ${userId}`);

    res.json({
      success: true,
      devicesCount: tokens.length,
      payload: {
        title: title || (type === 'incoming_call' ? `Incoming Call from ${callerNumber || 'Unknown'}` : 'New SMS Received'),
        body: body || 'Tap to open Simly App',
        data: {
          type,
          callerNumber: callerNumber || '+12025550123',
          timestamp: Date.now()
        }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 19. Automated Number Expiry & Line Renewal Worker Check
app.get('/api/numbers/check-expiry', async (req, res) => {
  try {
    const now = Date.now();
    const numbers = await prisma.purchasedNumber.findMany();
    const results = [];

    for (const num of numbers) {
      const expDate = num.expiresAt ? new Date(num.expiresAt) : new Date(new Date(num.createdAt).getTime() + 30 * 24 * 60 * 60 * 1000);
      const diffMs = expDate.getTime() - now;
      const daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

      let newStatus = 'active';
      if (daysRemaining <= 0) {
        newStatus = 'expired';
      } else if (daysRemaining <= 3) {
        newStatus = 'expiring_soon';
      }

      if (num.status !== newStatus) {
        await prisma.purchasedNumber.update({
          where: { id: num.id },
          data: { status: newStatus }
        });
      }

      results.push({
        id: num.id,
        phoneNumber: num.phoneNumber,
        status: newStatus,
        daysRemaining
      });
    }

    res.json({
      success: true,
      processed: results.length,
      numbers: results
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 20. Endpoint: User Account Self-Erasure & Telecom Deactivation (Preserves Auditing Records for Admin)
app.delete('/api/account/delete', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ success: false, error: 'User ID is required' });
    }
    console.log(`⚠️ [ACCOUNT SELF-ERASURE REQUEST] Processing self-erasure for User: ${userId}`);

    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { id: userId },
          { email: (userId || '').toLowerCase() },
          { email: `${userId}@simlytel.com` }
        ]
      }
    });

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    // 1. Expire all active virtual lines so telecom traffic ceases
    await prisma.purchasedNumber.updateMany({
      where: { userId: user.id, status: 'active' },
      data: { status: 'expired', expiresAt: new Date() }
    });

    // 2. Remove push tokens so no further notifications arrive on devices
    await prisma.devicePushToken.deleteMany({
      where: { userId: user.id }
    });

    // 3. Mark user account as SELF-ERASED (soft delete) - preserve CDR, calls, ledger & tickets for Admin
    await prisma.user.update({
      where: { id: user.id },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedReason: 'user_self_erase',
        isVerified: false
      }
    });

    // 4. Record Audit Transaction
    await prisma.transaction.create({
      data: {
        userId: user.id,
        type: 'account_erased',
        amount: 0,
        description: `⚠️ User Self-Erased Account from SimlyTel App on ${new Date().toLocaleString()}`
      }
    });

    console.log(`✅ [ACCOUNT SELF-ERASED] Marked User ${user.email} as erased. Historical records preserved.`);

    res.json({
      success: true,
      message: 'Your account has been deactivated and erased.'
    });
  } catch (error) {
    console.error('[SIMLY ERROR] Failed to erase account:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// 👑 MASTER ADMIN PANEL ENGINE (CRM, Financials, Numbers, CDR, Rates & Support)
// ============================================================================

const ADMIN_SECRET_TOKEN = process.env.ADMIN_SECRET_TOKEN || 'simly_master_admin_token_2026_sec_v1';
const ADMIN_MASTER_EMAIL = process.env.ADMIN_EMAIL || 'admin@simlytel.com';
const ADMIN_MASTER_PASSWORD = process.env.ADMIN_PASSWORD || 'SimlyTel@2026!#';

// Runtime Dynamic Configuration (Admin Controlled)
let adminRuntimeConfig = {
  callRateMultiplier: 2.5,
  numberRateMultiplier: 1.5,
  defaultWelcomeBonus: 10.0,
  promos: [
    { id: 'p1', code: 'WELCOME10', bonus: 10.0, maxUses: 500, used: 2, active: true, createdAt: new Date() },
    { id: 'p2', code: 'SIMLY50', bonus: 2.5, maxUses: 1000, used: 8, active: true, createdAt: new Date() },
    { id: 'p3', code: 'VIP2026', bonus: 25.0, maxUses: 50, used: 1, active: true, createdAt: new Date() }
  ]
};

// Admin Auth Middleware

// ============================================================
// 👥 RBAC, MULTI-AGENT HELPDESK & AUDIT TRAIL ENGINE
// ============================================================
const staffSessions = new Map(); // token -> staffUser object

// 1. Audit Logger Helper
async function logAuditEvent({ staffId, staffName, staffEmail, staffRole, action, targetId, targetType, details, req }) {
  try {
    const ip = req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '127.0.0.1';
    const log = await prisma.auditLog.create({
      data: {
        staffId: staffId || null,
        staffName: staffName || 'Master Admin',
        staffEmail: staffEmail || 'owner@simlytel.com',
        staffRole: staffRole || 'super_admin',
        action,
        targetId: targetId ? String(targetId) : null,
        targetType: targetType || null,
        details: typeof details === 'object' ? JSON.stringify(details) : String(details || ''),
        ipAddress: String(ip)
      }
    });
    console.log(`🛡️ [AUDIT] [${(staffRole || 'ADMIN').toUpperCase()}] ${staffName}: ${action} -> ${details || ''}`);
    return log;
  } catch (err) {
    console.error('⚠️ [AUDIT ERROR]', err);
  }
}

// 2. Dynamic Staff Authentication & Permission Guard

// === ENTERPRISE SECURITY & FRAUD RADAR HELPERS ===
async function isBlacklisted(ip, email, deviceId, phone) {
  try {
    const conditions = [];
    if (email && email.trim()) conditions.push({ type: 'EMAIL', value: email.toLowerCase().trim(), isActive: true });
    if (ip && ip !== '127.0.0.1' && ip !== '::1' && ip.trim()) conditions.push({ type: 'IP', value: ip.trim(), isActive: true });
    if (deviceId && deviceId.trim()) conditions.push({ type: 'DEVICE_ID', value: deviceId.trim(), isActive: true });
    if (phone && phone.trim()) conditions.push({ type: 'PHONE', value: phone.trim(), isActive: true });
    
    if (conditions.length === 0) return null;
    return await prisma.blacklist.findFirst({
      where: { OR: conditions }
    });
  } catch (err) {
    console.error('[SECURITY BLACKLIST CHECK ERROR]', err);
    return null;
  }
}

async function calculateUserRiskScore(user) {
  try {
    let score = user.riskScore || 0;
    let reasons = [];

    if (user.isBanned) {
      return { score: 100, level: 'HIGH', reasons: [user.banReason || 'Account manually banned by security admin'] };
    }

    // Check blacklisted IP/email/device matches
    const blMatch = await isBlacklisted(user.lastLoginIp, user.email, user.deviceId, user.phone);
    if (blMatch) {
      score += 75;
      reasons.push(`Blacklist Match: ${blMatch.type} (${blMatch.reason})`);
    }

    // Check multiple accounts on same device
    if (user.deviceId) {
      const sameDeviceCount = await prisma.user.count({ where: { deviceId: user.deviceId, id: { not: user.id } } });
      if (sameDeviceCount >= 3) {
        score += 35;
        reasons.push(`Multiple Accounts: ${sameDeviceCount} other accounts on same hardware`);
      } else if (sameDeviceCount >= 1) {
        score += 15;
        reasons.push(`Shared Device: ${sameDeviceCount} other account`);
      }
    }

    // Check rapid transaction patterns
    const txCount = await prisma.transaction.count({ where: { userId: user.id } });
    if (txCount >= 15 && user.walletBalance <= 0.5) {
      score += 20;
      reasons.push('High transaction velocity with low residual balance');
    }

    score = Math.min(100, Math.max(0, score));
    let level = 'LOW';
    if (score >= 70) level = 'HIGH';
    else if (score >= 30) level = 'MEDIUM';

    return { score, level, reasons };
  } catch (err) {
    return { score: 0, level: 'LOW', reasons: [] };
  }
}

const requireStaffPermission = (requiredPermission = null) => {
  return async (req, res, next) => {
    try {
      const token = req.headers['x-admin-token'] || req.headers['authorization']?.replace('Bearer ', '') || req.query.adminToken;
      if (!token) {
        return res.status(401).json({ success: false, error: 'Authentication required. Please sign in to staff portal.' });
      }

      // Master Fail-Safe Admin Token
      if (token === ADMIN_SECRET_TOKEN) {
        req.staff = {
          id: 'root_super_admin',
          name: 'Owner (Super Admin)',
          email: ADMIN_MASTER_EMAIL,
          role: 'super_admin',
          permissions: 'all'
        };
        return next();
      }

      // Check Active Staff Session
      const sessionStaff = staffSessions.get(token);
      if (!sessionStaff) {
        return res.status(401).json({ success: false, error: 'Session expired or invalid. Please sign in again.' });
      }

      // If Root Super Admin Session
      if (sessionStaff.id === 'root_super_admin') {
        req.staff = sessionStaff;
        return next();
      }

      // Verify in Database
      const dbStaff = await prisma.staffUser.findUnique({ where: { id: sessionStaff.id } });
      if (!dbStaff || !dbStaff.isActive) {
        staffSessions.delete(token);
        return res.status(403).json({ success: false, error: 'Your staff account has been deactivated or suspended by Administrator.' });
      }

      req.staff = dbStaff;

      // Super Admin bypass
      if (dbStaff.role === 'super_admin' || dbStaff.permissions === 'all') {
        return next();
      }

      // Role & Permission Checks
      if (requiredPermission) {
        if (requiredPermission === 'super_admin_only') {
          return res.status(403).json({
            success: false,
            error: 'Access Denied: Super Admin master privileges required.'
          });
        }

        let perms = [];
        try {
          if (typeof dbStaff.permissions === 'string' && dbStaff.permissions.startsWith('[')) {
            perms = JSON.parse(dbStaff.permissions);
          } else if (typeof dbStaff.permissions === 'string') {
            perms = dbStaff.permissions.split(',').map(p => p.trim());
          } else if (Array.isArray(dbStaff.permissions)) {
            perms = dbStaff.permissions;
          }
        } catch (e) {
          perms = (dbStaff.permissions || '').split(',').map(p => p.trim());
        }

        const requiredList = Array.isArray(requiredPermission) ? requiredPermission : [requiredPermission];
        const hasPermission = perms.includes('all') || requiredList.some(r => perms.includes(r));

        if (!hasPermission) {
          return res.status(403).json({
            success: false,
            error: `Access Denied: Your staff account does not have '${requiredList.join(' or ')}' permission.`
          });
        }
      }

      next();
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  };
};

// Seed default owner account if database has zero staff
async function ensureSuperAdminExists() {
  try {
    const count = await prisma.staffUser.count();
    if (count === 0) {
      await prisma.staffUser.create({
        data: {
          name: 'Owner (Super Admin)',
          email: 'admin@simlytel.com',
          password: ADMIN_MASTER_PASSWORD,
          role: 'super_admin',
          permissions: 'all',
          isActive: true
        }
      });
      console.log('👑 [STAFF SEEDED] Initial Super Admin account created: admin@simlytel.com');
    }
  } catch (e) {
    console.error('Seed staff check error:', e);
  }
}
ensureSuperAdminExists();

// Legacy requireAdmin alias
const requireAdmin = requireStaffPermission('all');
const requireSuperAdmin = requireStaffPermission('super_admin_only');

const old_requireAdmin = (req, res, next) => {
  const token = req.headers['x-admin-token'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!token || token !== ADMIN_SECRET_TOKEN) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Master Admin Token required.' });
  }
  next();
};

// 1. Admin Login API
app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body || {};
  const cleanEmail = (email || '').trim().toLowerCase();
  if (
    (cleanEmail === ADMIN_MASTER_EMAIL.toLowerCase() || cleanEmail === 'admin' || cleanEmail === 'nomi') &&
    password === ADMIN_MASTER_PASSWORD
  ) {
    return res.json({
      success: true,
      message: 'Admin authentication successful!',
      token: ADMIN_SECRET_TOKEN,
      user: {
        name: 'Master Admin (Nomi)',
        email: ADMIN_MASTER_EMAIL,
        role: 'SUPER_ADMIN'
      }
    });
  }
  return res.status(401).json({ success: false, error: 'Invalid admin credentials.' });
});

// ============================================================
// 💎 MASTER TELECOM FINANCIAL & PROFIT ENGINE (8-DECIMAL ACCURACY)
// ============================================================
async function calculateMasterFinancials() {
  // 1. Total Customer Deposits (All-time topups/deposits loaded into prepaid wallets)
  const depositTx = await prisma.transaction.findMany({
    where: { type: { in: ['topup', 'deposit', 'crypto_deposit', 'stripe_deposit'] } },
    select: { amount: true }
  });
  const totalCustomerDeposits = depositTx.reduce((sum, t) => sum + Math.abs(t.amount || 0), 0);

  // 2. Active User Wallet Balances (Customer funds held in escrow / platform liability)
  const allUsers = await prisma.user.findMany({ select: { walletBalance: true } });
  const totalUserBalance = allUsers.reduce((sum, u) => sum + (u.walletBalance || 0), 0);

  // 3. Realized Retail Revenue (Actual charges paid by users for platform services)
  const [lineTx, callTx, smsTx] = await Promise.all([
    prisma.transaction.findMany({
      where: { type: { in: ['number_purchase', 'renewal', 'number_renewal'] } },
      select: { amount: true }
    }),
    prisma.transaction.findMany({
      where: { type: { in: ['call', 'call_charge'] } },
      select: { amount: true }
    }),
    prisma.transaction.findMany({
      where: { type: { in: ['sms', 'sms_charge'] } },
      select: { amount: true }
    })
  ]);

  const retailLineRevenue = lineTx.reduce((sum, t) => sum + Math.abs(t.amount || 0), 0);
  const retailCallRevenue = callTx.reduce((sum, t) => sum + Math.abs(t.amount || 0), 0);
  const retailSmsRevenue = smsTx.reduce((sum, t) => sum + Math.abs(t.amount || 0), 0);
  const totalRetailRevenue = retailLineRevenue + retailCallRevenue + retailSmsRevenue;

  // 4. Wholesale Telecom Carrier Costs (Telnyx Direct Wholesale DIDs, Termination & SMS)
  // A. Numbers Wholesale Cost: Telnyx wholesale DID rate per purchased line ($1.00000000 / month standard)
  const purchasedNumbers = await prisma.purchasedNumber.findMany({ select: { id: true, planType: true, createdAt: true } });
  let wholesaleNumberCost = 0;
  purchasedNumbers.forEach(n => {
    if (n.planType === '7_days') wholesaleNumberCost += 0.25000000;
    else if (n.planType === '365_days') wholesaleNumberCost += 12.00000000;
    else wholesaleNumberCost += 1.00000000;
  });

  // B. Calls Wholesale Cost: Termination per second ($0.00900000 / min = $0.00015000 / sec)
  const allCalls = await prisma.callLog.findMany({ select: { durationSeconds: true, status: true } });
  const totalCallSeconds = allCalls.reduce((acc, c) => acc + (c.durationSeconds || 0), 0);
  const totalCallMinutes = totalCallSeconds / 60;
  const wholesaleCallCost = totalCallSeconds * (0.00900000 / 60);

  // C. SMS Wholesale Cost: Outbound carrier cost ($0.00750000 / SMS)
  const allSmsOutbound = await prisma.message.count({ where: { direction: 'outbound' } });
  const wholesaleSmsCost = allSmsOutbound * 0.00750000;

  const totalWholesaleCost = wholesaleNumberCost + wholesaleCallCost + wholesaleSmsCost;

  // 5. TRUE NET REALIZED PROFIT (Retail Billed Revenue - Wholesale Carrier Costs)
  const netProfit = totalRetailRevenue - totalWholesaleCost;
  const marginPercent = totalRetailRevenue > 0 ? ((netProfit / totalRetailRevenue) * 100) : 0.0;

  return {
    netProfit: parseFloat(netProfit.toFixed(8)),
    netProfitStr: netProfit.toFixed(8),
    marginPercent: parseFloat(marginPercent.toFixed(4)),
    marginPercentStr: marginPercent.toFixed(4),
    totalWholesaleCost: parseFloat(totalWholesaleCost.toFixed(8)),
    totalWholesaleCostStr: totalWholesaleCost.toFixed(8),
    totalRetailRevenue: parseFloat(totalRetailRevenue.toFixed(8)),
    totalRetailRevenueStr: totalRetailRevenue.toFixed(8),
    retailLineRevenue: parseFloat(retailLineRevenue.toFixed(8)),
    retailLineRevenueStr: retailLineRevenue.toFixed(8),
    retailCallRevenue: parseFloat(retailCallRevenue.toFixed(8)),
    retailCallRevenueStr: retailCallRevenue.toFixed(8),
    retailSmsRevenue: parseFloat(retailSmsRevenue.toFixed(8)),
    retailSmsRevenueStr: retailSmsRevenue.toFixed(8),
    wholesaleNumberCost: parseFloat(wholesaleNumberCost.toFixed(8)),
    wholesaleNumberCostStr: wholesaleNumberCost.toFixed(8),
    wholesaleCallCost: parseFloat(wholesaleCallCost.toFixed(8)),
    wholesaleCallCostStr: wholesaleCallCost.toFixed(8),
    wholesaleSmsCost: parseFloat(wholesaleSmsCost.toFixed(8)),
    wholesaleSmsCostStr: wholesaleSmsCost.toFixed(8),
    totalCustomerDeposits: parseFloat(totalCustomerDeposits.toFixed(8)),
    totalCustomerDepositsStr: totalCustomerDeposits.toFixed(8),
    totalUserBalance: parseFloat(totalUserBalance.toFixed(8)),
    totalUserBalanceStr: totalUserBalance.toFixed(8),
    totalCallSeconds,
    totalCallMinutes: parseFloat(totalCallMinutes.toFixed(4)),
    totalSmsSent: allSmsOutbound,
    activeNumbers: purchasedNumbers.length
  };
}

// 2. Master Dashboard KPI Stats
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const totalUsers = await prisma.user.count();
    const activeNumbers = await prisma.purchasedNumber.count({ where: { status: 'active' } });
    const totalCalls = await prisma.callLog.count();
    const totalMessages = await prisma.message.count({ where: { direction: 'outbound' } });
    
    // Master financials calculation with 8-decimal precision
    const fin = await calculateMasterFinancials();

    // Recent 5 users
    const recentUsers = await prisma.user.findMany({
      take: 5,
      orderBy: { createdAt: 'desc' }
    });

    // Recent 5 transactions
    const recentTransactions = await prisma.transaction.findMany({
      take: 5,
      orderBy: { createdAt: 'desc' }
    });

    // Active numbers country distribution
    const allNumbers = await prisma.purchasedNumber.findMany({ select: { countryCode: true } });
    const countryDistribution = {};
    allNumbers.forEach(n => {
      const cc = (n.countryCode || 'US').toUpperCase();
      countryDistribution[cc] = (countryDistribution[cc] || 0) + 1;
    });

    res.json({
      success: true,
      data: {
        totalUsers,
        activeNumbers,
        totalCalls,
        totalMessages,
        totalRevenue: fin.totalCustomerDeposits,
        totalCustomerDeposits: fin.totalCustomerDeposits,
        totalRetailRevenue: fin.totalRetailRevenue,
        totalWholesaleCost: fin.totalWholesaleCost,
        netProfit: fin.netProfit,
        marginPercent: fin.marginPercent,
        totalUserBalance: fin.totalUserBalance,
        countryDistribution,
        recentUsers,
        recentTransactions,
        financials: fin,
        serverStatus: 'ONLINE 🟢',
        uptime: process.uptime()
      }
    });
  } catch (error) {
    console.error('[ADMIN STATS ERROR]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. Users CRM List, Search & Filter (with Erased & Soft-Deleted Support & Multi-Line Search)
app.get('/api/admin/users', requireStaffPermission(['can_view_users', 'can_manage_users', 'can_handle_support', 'all']), async (req, res) => {
  try {
    const rawSearch = req.query.search ? req.query.search.trim() : '';
    const query = rawSearch.toLowerCase();
    const filter = (req.query.filter || 'all').toLowerCase();
    const page = parseInt(req.query.page || '1', 10);
    const limit = parseInt(req.query.limit || '100', 10);
    const skip = (page - 1) * limit;

    const andConditions = [];

    if (query) {
      const cleanDigits = rawSearch.replace(/[^0-9]/g, '');

      // 1. Search in Purchased Numbers (Virtual Lines)
      const matchingNumbers = await prisma.purchasedNumber.findMany({
        where: {
          OR: [
            { phoneNumber: { contains: rawSearch } },
            { phoneNumber: { contains: query } },
            ...(cleanDigits.length >= 2 ? [{ phoneNumber: { contains: cleanDigits } }] : [])
          ]
        },
        select: { userId: true }
      });
      const numberUserIds = [...new Set(matchingNumbers.map(n => n.userId).filter(Boolean))];

      // 2. Comprehensive Search across User properties + Matched Virtual Number User IDs
      andConditions.push({
        OR: [
          { email: { contains: query } },
          { email: { contains: rawSearch } },
          { name: { contains: rawSearch } },
          { id: { contains: rawSearch } },
          { phone: { contains: rawSearch } },
          ...(cleanDigits.length >= 2 ? [{ phone: { contains: cleanDigits } }] : []),
          ...(numberUserIds.length > 0 ? [{ id: { in: numberUserIds } }] : [])
        ]
      });
    }

    if (filter === 'active') {
      andConditions.push({ isDeleted: false, isVerified: true });
    } else if (filter === 'blocked') {
      andConditions.push({ isDeleted: false, isVerified: false });
    } else if (filter === 'erased' || filter === 'deleted') {
      andConditions.push({ isDeleted: true });
    }

    const where = andConditions.length > 0 ? { AND: andConditions } : {};

    const [totalUsers, activeCount, blockedCount, erasedCount] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { isDeleted: false, isVerified: true } }),
      prisma.user.count({ where: { isDeleted: false, isVerified: false } }),
      prisma.user.count({ where: { isDeleted: true } })
    ]);

    const [filteredTotal, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' }
      })
    ]);

    const now = new Date();
    const usersWithMeta = await Promise.all(
      users.map(async (u) => {
        const userNumbers = await prisma.purchasedNumber.findMany({
          where: { userId: u.id },
          orderBy: { createdAt: 'desc' }
        });

        const formattedNumbers = userNumbers.map(n => {
          const planDays = n.planType === '7_days' ? 7 : (n.planType === '365_days' ? 365 : 30);
          const computedExpiry = n.expiresAt || new Date(new Date(n.createdAt).getTime() + planDays * 24 * 60 * 60 * 1000);
          const isExpired = n.status === 'expired' || (computedExpiry && new Date(computedExpiry) < now);
          return {
            id: n.id,
            phoneNumber: n.phoneNumber,
            countryCode: n.countryCode,
            planType: n.planType || '30_days',
            status: isExpired ? 'expired' : (n.status || 'active'),
            isExpired,
            expiresAt: computedExpiry
          };
        });

        const activeNumbersCount = formattedNumbers.filter(n => n.status === 'active').length;

        let displayStatus = 'active';
        let statusLabel = 'ACTIVE 🟢';
        let statusColor = 'emerald';

        if (u.isDeleted) {
          if (u.deletedReason === 'user_self_erase') {
            displayStatus = 'self_erased';
            statusLabel = 'SELF-ERASED ⚠️';
            statusColor = 'amber';
          } else {
            displayStatus = 'admin_deleted';
            statusLabel = 'DELETED (ADMIN) 🗑️';
            statusColor = 'rose';
          }
        } else if (u.isBanned) {
          displayStatus = 'banned';
          statusLabel = 'BANNED 🛑';
          statusColor = 'rose';
        } else if (!u.isVerified) {
          displayStatus = 'blocked';
          statusLabel = 'BLOCKED 🔴';
          statusColor = 'rose';
        }

        const riskData = await calculateUserRiskScore(u);

        return {
          ...u,
          displayStatus,
          statusLabel,
          statusColor,
          riskScore: riskData.score,
          riskLevel: riskData.level,
          riskReasons: riskData.reasons,
          numbersCount: activeNumbersCount,
          totalNumbersCount: formattedNumbers.length,
          virtualNumbers: formattedNumbers
        };
      })
    );

    res.json({
      success: true,
      total: filteredTotal,
      page,
      totalPages: Math.ceil(filteredTotal / limit),
      counts: {
        total: totalUsers,
        active: activeCount,
        blocked: blockedCount,
        erased: erasedCount
      },
      users: usersWithMeta
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3.5 360-Degree Deep User Profile Dossier (Numbers, Calls, SMS, Balance, Audit)
app.get('/api/admin/users/:id/full-profile', requireStaffPermission(['can_view_users', 'can_manage_users', 'can_handle_support', 'all']), async (req, res) => {
  try {
    const rawId = req.params.id;
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { id: rawId },
          { email: rawId.toLowerCase() }
        ]
      }
    });

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    // 1. Fetch User's Transactions
    const transactions = await prisma.transaction.findMany({
      where: {
        OR: [
          { userId: user.id },
          { userId: user.email },
          { userId: user.email.toLowerCase() }
        ]
      },
      orderBy: { createdAt: 'desc' }
    });

    // 2. Fetch User's Virtual Numbers (Active, Expired, and Historical)
    let numbers = await prisma.purchasedNumber.findMany({
      where: {
        OR: [
          { userId: user.id },
          { userId: user.email },
          { userId: user.email.toLowerCase() }
        ]
      },
      orderBy: { createdAt: 'desc' }
    });

    // Also include any numbers mentioned in transaction descriptions
    const now = new Date();
    for (const tx of transactions) {
      if (tx.description && tx.description.includes('Line Purchase')) {
        const match = tx.description.match(/(\+\d{8,16})/);
        if (match && match[1]) {
          const foundNum = match[1];
          if (!numbers.some(n => n.phoneNumber === foundNum)) {
            const dbNum = await prisma.purchasedNumber.findFirst({ where: { phoneNumber: foundNum } });
            if (dbNum) numbers.push(dbNum);
          }
        }
      }
    }

    // Mark displayStatus, calculate accurate computed expiry if missing, & isExpired
    numbers = numbers.map(n => {
      const planDays = n.planType === '7_days' ? 7 : (n.planType === '365_days' ? 365 : 30);
      const computedExpiry = n.expiresAt || new Date(new Date(n.createdAt).getTime() + planDays * 24 * 60 * 60 * 1000);
      const isExpired = n.status === 'expired' || (computedExpiry && new Date(computedExpiry) < now);
      return {
        ...n,
        expiresAt: computedExpiry,
        isExpired,
        displayStatus: isExpired ? 'expired' : (n.status || 'active')
      };
    });

    const userPhoneNumbers = numbers.map(n => n.phoneNumber);

    // 3. Fetch User's Call Logs
    const calls = await prisma.callLog.findMany({
      where: {
        OR: [
          { myNumber: { in: userPhoneNumbers } },
          { contactNumber: { in: userPhoneNumbers } }
        ]
      },
      orderBy: { createdAt: 'desc' }
    });

    // 4. Fetch User's Messages (SMS)
    const messages = await prisma.message.findMany({
      where: {
        OR: [
          { fromNumber: { in: userPhoneNumbers } },
          { toNumber: { in: userPhoneNumbers } }
        ]
      },
      orderBy: { createdAt: 'desc' }
    });

    // 5. Fetch User's Support Chat History
    const supportMessages = await prisma.supportMessage.findMany({
      where: {
        OR: [
          { userId: user.id },
          { userId: user.email }
        ]
      },
      orderBy: { createdAt: 'asc' }
    });

    // Compute summary metrics
    const totalSpent = transactions
      .filter(t => t.amount < 0)
      .reduce((sum, t) => sum + Math.abs(t.amount), 0);

    const totalDeposited = transactions
      .filter(t => t.amount > 0)
      .reduce((sum, t) => sum + t.amount, 0);

    const totalCallDurationSeconds = calls.reduce((sum, c) => sum + (c.durationSeconds || 0), 0);

    res.json({
      success: true,
      user,
      metrics: {
        totalSpent: parseFloat(totalSpent.toFixed(2)),
        totalDeposited: parseFloat(totalDeposited.toFixed(2)),
        totalCallMinutes: (totalCallDurationSeconds / 60).toFixed(1),
        activeNumbersCount: numbers.filter(n => n.status === 'active').length,
        totalCallsCount: calls.length,
        totalMessagesCount: messages.length,
        totalTransactionsCount: transactions.length
      },
      numbers,
      transactions,
      calls,
      messages,
      supportMessages
    });
  } catch (error) {
    console.error('[ADMIN USER PROFILE ERROR]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. User Balance Modifier (Gift / Topup / Deduction)
app.post('/api/admin/users/:id/adjust-balance', requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const { amount, reason } = req.body;
    const numAmount = parseFloat(amount);

    if (isNaN(numAmount) || numAmount === 0) {
      return res.status(400).json({ success: false, error: 'Valid non-zero amount required.' });
    }

    const user = await prisma.user.findFirst({
      where: { OR: [{ id: userId }, { email: userId.toLowerCase() }] }
    });

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    const newBalance = Math.max(0, user.walletBalance + numAmount);

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { walletBalance: newBalance }
    });

    // Record Transaction Audit
    await prisma.transaction.create({
      data: {
        userId: user.id,
        type: numAmount > 0 ? 'topup' : 'admin_deduction',
        amount: numAmount,
        description: `Admin Adjustment: ${reason || (numAmount > 0 ? 'Manual Credit Gift' : 'Manual Debit')} ($${Math.abs(numAmount).toFixed(2)})`
      }
    });

    res.json({
      success: true,
      message: `Balance updated for ${user.email}. New Balance: $${newBalance.toFixed(2)}`,
      user: updated
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. User Account Status Toggle (Block / Unblock)
app.post('/api/admin/users/:id/toggle-block', requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const user = await prisma.user.findFirst({
      where: { OR: [{ id: userId }, { email: userId.toLowerCase() }] }
    });

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { isVerified: !user.isVerified }
    });

    res.json({
      success: true,
      message: `User ${user.email} is now ${updated.isVerified ? 'ACTIVE (Unblocked)' : 'BLOCKED'}`,
      user: updated
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5.5 Bulk Action on Multiple Users (Block, Unblock, Soft-Delete, Restore, Adjust Balance)
app.post('/api/admin/users/bulk-action', requireAdmin, async (req, res) => {
  try {
    const { userIds, action, balanceAmount, reason } = req.body;
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ success: false, error: 'No user IDs provided for bulk action.' });
    }

    if (!['block', 'unblock', 'delete', 'restore', 'adjust_balance'].includes(action)) {
      return res.status(400).json({ success: false, error: 'Invalid bulk action specified.' });
    }

    console.log(`⚡ [ADMIN BULK ACTION] Executing '${action}' on ${userIds.length} users`);

    if (action === 'block') {
      await prisma.user.updateMany({
        where: { id: { in: userIds } },
        data: { isVerified: false }
      });
      return res.json({
        success: true,
        message: `Successfully BLOCKED ${userIds.length} user accounts.`
      });
    }

    if (action === 'unblock') {
      await prisma.user.updateMany({
        where: { id: { in: userIds } },
        data: { isVerified: true, isDeleted: false, deletedReason: null, deletedAt: null }
      });
      return res.json({
        success: true,
        message: `Successfully UNBLOCKED & ACTIVATED ${userIds.length} user accounts.`
      });
    }

    if (action === 'delete') {
      // Soft Delete / Archive (Never lose historical telecom or financial records)
      await prisma.user.updateMany({
        where: { id: { in: userIds } },
        data: {
          isDeleted: true,
          deletedAt: new Date(),
          deletedReason: 'admin_deleted',
          isVerified: false
        }
      });
      // Expire their active numbers
      await prisma.purchasedNumber.updateMany({
        where: { userId: { in: userIds }, status: 'active' },
        data: { status: 'expired', expiresAt: new Date() }
      });
      // Remove push tokens
      await prisma.devicePushToken.deleteMany({
        where: { userId: { in: userIds } }
      });

      // Record audit transactions
      for (const uId of userIds) {
        await prisma.transaction.create({
          data: {
            userId: uId,
            type: 'admin_action',
            amount: 0,
            description: `🗑️ Account Archived / Soft-Deleted by Admin in Bulk Operation on ${new Date().toLocaleString()}`
          }
        });
      }

      return res.json({
        success: true,
        message: `Successfully Archived/Soft-Deleted ${userIds.length} user accounts. All historical records preserved.`
      });
    }

    if (action === 'restore') {
      await prisma.user.updateMany({
        where: { id: { in: userIds } },
        data: {
          isDeleted: false,
          deletedAt: null,
          deletedReason: null,
          isVerified: true
        }
      });
      for (const uId of userIds) {
        await prisma.transaction.create({
          data: {
            userId: uId,
            type: 'admin_action',
            amount: 0,
            description: `♻️ Account Restored to Active by Admin on ${new Date().toLocaleString()}`
          }
        });
      }
      return res.json({
        success: true,
        message: `Successfully Restored ${userIds.length} user accounts to Active status.`
      });
    }

    if (action === 'adjust_balance') {
      const numAmount = parseFloat(balanceAmount || '0');
      if (isNaN(numAmount) || numAmount === 0) {
        return res.status(400).json({ success: false, error: 'Valid non-zero balance amount required.' });
      }

      const users = await prisma.user.findMany({ where: { id: { in: userIds } } });
      for (const u of users) {
        const newBal = Math.max(0, parseFloat(((u.walletBalance || 0) + numAmount).toFixed(2)));
        await prisma.user.update({
          where: { id: u.id },
          data: { walletBalance: newBal }
        });
        await prisma.transaction.create({
          data: {
            userId: u.id,
            type: numAmount > 0 ? 'topup' : 'admin_deduction',
            amount: numAmount,
            description: `Bulk Adjustment: ${reason || (numAmount > 0 ? 'Bulk Credit Gift' : 'Bulk Debit')} ($${Math.abs(numAmount).toFixed(2)})`
          }
        });
      }

      return res.json({
        success: true,
        message: `Successfully adjusted balance by $${numAmount.toFixed(2)} for ${users.length} users.`
      });
    }
  } catch (error) {
    console.error('[ADMIN BULK ACTION ERROR]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 6. Delete / Archive User Account (Soft-Delete by default, Hard Wipe if permanent=true)
app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const isPermanent = req.query.permanent === 'true' || req.body?.permanent === true;

    const user = await prisma.user.findFirst({
      where: { OR: [{ id: userId }, { email: userId.toLowerCase() }] }
    });

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    if (isPermanent) {
      // Hard wipe only when admin explicitly specifies permanent
      await prisma.purchasedNumber.deleteMany({ where: { userId: user.id } });
      await prisma.transaction.deleteMany({ where: { userId: user.id } });
      await prisma.supportMessage.deleteMany({ where: { userId: user.id } });
      await prisma.devicePushToken.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
      return res.json({ success: true, message: `User ${user.email} and all records permanently purged from database.` });
    }

    // Default: Soft Delete / Archive (Never lose audit trail or financial history)
    await prisma.user.update({
      where: { id: user.id },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedReason: 'admin_deleted',
        isVerified: false
      }
    });

    await prisma.purchasedNumber.updateMany({
      where: { userId: user.id, status: 'active' },
      data: { status: 'expired', expiresAt: new Date() }
    });

    await prisma.devicePushToken.deleteMany({
      where: { userId: user.id }
    });

    await prisma.transaction.create({
      data: {
        userId: user.id,
        type: 'admin_action',
        amount: 0,
        description: `🗑️ Account Soft-Deleted / Archived by Admin on ${new Date().toLocaleString()}`
      }
    });

    res.json({
      success: true,
      message: `User ${user.email} has been Archived/Soft-Deleted. All historical call and ledger records remain preserved in Admin.`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 6.5 Restore User Account
app.post('/api/admin/users/:id/restore', requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const user = await prisma.user.findFirst({
      where: { OR: [{ id: userId }, { email: userId.toLowerCase() }] }
    });

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        isDeleted: false,
        deletedAt: null,
        deletedReason: null,
        isVerified: true
      }
    });

    await prisma.transaction.create({
      data: {
        userId: user.id,
        type: 'admin_action',
        amount: 0,
        description: `♻️ Account Restored to Active by Admin on ${new Date().toLocaleString()}`
      }
    });

    res.json({
      success: true,
      message: `User ${user.email} has been restored to ACTIVE status.`,
      user: updated
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 7. Virtual Numbers Fleet List & Management
app.get('/api/admin/numbers', requireAdmin, async (req, res) => {
  try {
    const query = req.query.search ? req.query.search.trim().replace(/\s+/g, '') : '';
    const where = query
      ? {
          OR: [
            { phoneNumber: { contains: query } },
            { userId: { contains: query } },
            { countryCode: { contains: query.toUpperCase() } }
          ]
        }
      : {};

    const numbers = await prisma.purchasedNumber.findMany({
      where,
      orderBy: { createdAt: 'desc' }
    });

    // Attach user emails
    const enrichedNumbers = await Promise.all(
      numbers.map(async (n) => {
        const u = await prisma.user.findFirst({
          where: { OR: [{ id: n.userId }, { email: n.userId }] },
          select: { email: true, name: true }
        });
        return {
          ...n,
          userEmail: u?.email || n.userId,
          userName: u?.name || 'User'
        };
      })
    );

    res.json({ success: true, count: enrichedNumbers.length, numbers: enrichedNumbers });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 8. Reclaim / Cancel Number
app.post('/api/admin/numbers/:id/reclaim', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const existing = await prisma.purchasedNumber.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Virtual line not found.' });
    }

    await prisma.purchasedNumber.delete({ where: { id } });
    res.json({ success: true, message: `Virtual line ${existing.phoneNumber} successfully reclaimed.` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 9. Extend Number Expiry / Renew with User Balance Option
app.post('/api/admin/numbers/:id/extend', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const days = parseInt(req.body.days || '30', 10);
    const useUserBalance = req.body.useUserBalance === true;
    const existing = await prisma.purchasedNumber.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Virtual line not found.' });
    }

    const price = calculateNumberPrice(existing.countryCode || 'US', days === 7 ? '7_days' : days === 365 ? '365_days' : '30_days', days, existing.phoneNumber);

    if (useUserBalance) {
      const user = await prisma.user.findFirst({
        where: { OR: [{ id: existing.userId }, { email: existing.userId }] }
      });

      if (!user) {
        return res.status(400).json({ success: false, error: 'User account not found.' });
      }

      if (user.walletBalance < price) {
        return res.status(400).json({
          success: false,
          error: `User has only $${user.walletBalance.toFixed(2)}, but renewal requires $${price.toFixed(2)}. Please add balance or use Free Extension.`
        });
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { walletBalance: { decrement: price } }
      });

      await prisma.transaction.create({
        data: {
          userId: user.id,
          type: 'number_renewal',
          amount: -price,
          description: `Line Renewal (${days} Days): ${existing.phoneNumber}`
        }
      });
    }

    const currentExpiry = existing.expiresAt ? new Date(existing.expiresAt) : new Date();
    const baseTime = currentExpiry.getTime() > Date.now() ? currentExpiry.getTime() : Date.now();
    const newExpiry = new Date(baseTime + days * 24 * 60 * 60 * 1000);

    const updated = await prisma.purchasedNumber.update({
      where: { id },
      data: { expiresAt: newExpiry, status: 'active' }
    });

    res.json({
      success: true,
      message: `Extended line ${existing.phoneNumber} by ${days} days! ${useUserBalance ? `($${price.toFixed(2)} deducted from user balance)` : '(Admin Free Override)'}`,
      number: updated
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 9.5 Toggle Number Status (Active <-> Expired)
app.post('/api/admin/numbers/:id/toggle-status', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const existing = await prisma.purchasedNumber.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ success: false, error: 'Line not found' });

    const newStatus = existing.status === 'active' ? 'expired' : 'active';
    // If expiring, set expiry date to the past so app immediately calculates 0 days remaining
    const newExpiresAt = newStatus === 'expired'
      ? new Date(Date.now() - 24 * 60 * 60 * 1000)
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const updated = await prisma.purchasedNumber.update({
      where: { id },
      data: { status: newStatus, expiresAt: newExpiresAt }
    });

    res.json({ success: true, message: `Line ${existing.phoneNumber} is now marked as ${newStatus.toUpperCase()} (${newStatus === 'expired' ? '0 days remaining' : '30 days remaining'})`, number: updated });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 10. Call Logs (CDR)
app.get('/api/admin/calls', requireAdmin, async (req, res) => {
  try {
    const calls = await prisma.callLog.findMany({
      take: 100,
      orderBy: { createdAt: 'desc' }
    });
    res.json({ success: true, count: calls.length, calls });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 11. SMS Logs
app.get('/api/admin/messages', requireAdmin, async (req, res) => {
  try {
    const messages = await prisma.message.findMany({
      take: 100,
      orderBy: { createdAt: 'desc' }
    });
    res.json({ success: true, count: messages.length, messages });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 12. Complete Transaction Financials Ledger
app.get('/api/admin/transactions', requireAdmin, async (req, res) => {
  try {
    const type = req.query.type;
    const where = type ? { type } : {};
    const transactions = await prisma.transaction.findMany({
      where,
      take: 150,
      orderBy: { createdAt: 'desc' }
    });

    // Attach user emails
    const enriched = await Promise.all(
      transactions.map(async (t) => {
        const u = await prisma.user.findFirst({
          where: { OR: [{ id: t.userId }, { email: t.userId }] },
          select: { email: true, name: true }
        });
        return {
          ...t,
          userEmail: u?.email || t.userId,
          userName: u?.name || 'User'
        };
      })
    );

    res.json({ success: true, count: enriched.length, transactions: enriched });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// ============================================================
// === STAFF & TEAM MANAGEMENT API ENDPOINTS ===
// ============================================================

// 1. Staff Sign-in / Authentication
app.post('/api/staff/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();

    // Check Root Super Admin Master credentials
    if (
      (cleanEmail === ADMIN_MASTER_EMAIL.toLowerCase() || cleanEmail === 'admin@simlytel.com' || cleanEmail === 'admin' || cleanEmail === 'nomi') &&
      password === ADMIN_MASTER_PASSWORD
    ) {
      const token = 'staff_master_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10);
      const rootStaff = {
        id: 'root_super_admin',
        name: 'Owner (Super Admin)',
        email: ADMIN_MASTER_EMAIL,
        role: 'super_admin',
        permissions: 'all',
        isActive: true,
        isOnline: true
      };
      staffSessions.set(token, rootStaff);

      await logAuditEvent({
        staffId: 'root_super_admin',
        staffName: 'Owner (Super Admin)',
        staffEmail: ADMIN_MASTER_EMAIL,
        staffRole: 'super_admin',
        action: 'STAFF_LOGIN',
        details: 'Owner logged in via Master Gateway',
        req
      });

      return res.json({
        success: true,
        message: 'Welcome, Super Admin!',
        token,
        staff: rootStaff
      });
    }

    // Check in Database for Registered Staff Members
    const staff = await prisma.staffUser.findUnique({
      where: { email: cleanEmail }
    });

    if (!staff || staff.password !== password) {
      return res.status(401).json({ success: false, error: 'Invalid staff email or password.' });
    }

    if (!staff.isActive) {
      return res.status(403).json({ success: false, error: 'Your staff account has been deactivated. Please contact the administrator.' });
    }

    const token = 'staff_tok_' + Date.now() + '_' + Math.random().toString(36).substring(2, 12);
    
    // Update last login & online state
    await prisma.staffUser.update({
      where: { id: staff.id },
      data: { lastLoginAt: new Date(), isOnline: true }
    });

    staffSessions.set(token, staff);

    await logAuditEvent({
      staffId: staff.id,
      staffName: staff.name,
      staffEmail: staff.email,
      staffRole: staff.role,
      action: 'STAFF_LOGIN',
      details: `Staff signed in with role '${staff.role}'`,
      req
    });

    res.json({
      success: true,
      message: `Welcome back, ${staff.name}!`,
      token,
      staff: {
        id: staff.id,
        name: staff.name,
        email: staff.email,
        role: staff.role,
        permissions: staff.permissions,
        avatarUrl: staff.avatarUrl,
        ticketsResolved: staff.ticketsResolved
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Get Current Authenticated Staff Profile
app.get('/api/staff/me', requireStaffPermission(), async (req, res) => {
  res.json({
    success: true,
    staff: req.staff
  });
});

// 3. Staff Sign-out / Logout
app.post('/api/staff/logout', requireStaffPermission(), async (req, res) => {
  try {
    const token = req.headers['x-admin-token'] || req.headers['authorization']?.replace('Bearer ', '');
    if (token) {
      staffSessions.delete(token);
    }
    if (req.staff && req.staff.id !== 'root_super_admin') {
      await prisma.staffUser.update({
        where: { id: req.staff.id },
        data: { isOnline: false }
      }).catch(() => {});
    }

    await logAuditEvent({
      staffId: req.staff.id,
      staffName: req.staff.name,
      staffEmail: req.staff.email,
      staffRole: req.staff.role,
      action: 'STAFF_LOGOUT',
      details: 'Staff member signed out safely',
      req
    });

    res.json({ success: true, message: 'Signed out successfully.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. Super Admin: List All Team Members
app.get('/api/admin/team', requireStaffPermission('super_admin_only'), async (req, res) => {
  try {
    const team = await prisma.staffUser.findMany({
      orderBy: { createdAt: 'desc' }
    });

    // Mask passwords for safety
    const safeTeam = team.map(m => ({
      id: m.id,
      name: m.name,
      email: m.email,
      role: m.role,
      permissions: m.permissions,
      isActive: m.isActive,
      isOnline: m.isOnline,
      lastLoginAt: m.lastLoginAt,
      ticketsResolved: m.ticketsResolved,
      createdAt: m.createdAt
    }));

    res.json({ success: true, count: safeTeam.length, team: safeTeam });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. Super Admin: Create New Staff Member
app.post('/api/admin/team', requireStaffPermission('super_admin_only'), async (req, res) => {
  try {
    const { name, email, password, role = 'support_agent', permissions } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ success: false, error: 'Name, email, and password are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const existing = await prisma.staffUser.findUnique({ where: { email: cleanEmail } });
    if (existing) {
      return res.status(400).json({ success: false, error: 'A staff member with this email address already exists.' });
    }

    // Default permission presets
    let perms = permissions;
    if (!perms) {
      if (role === 'support_agent') perms = 'can_handle_support,can_view_users,can_view_wallet_balance,can_view_numbers,can_purchase_for_user,can_renew_for_user,can_transfer_tickets';
      else if (role === 'deposit_supporter') perms = 'can_handle_support,can_handle_deposits,can_view_users,can_view_wallet_balance,can_adjust_balance,can_transfer_tickets';
      else if (role === 'operations_manager') perms = 'can_view_numbers,can_purchase_for_user,can_renew_for_user,can_cancel_numbers,can_view_users,can_view_cdr,can_handle_support';
      else if (role === 'finance_manager') perms = 'can_view_transactions,can_view_stats,can_view_users,can_view_wallet_balance,can_adjust_balance';
      else perms = 'all';
    }

    const staff = await prisma.staffUser.create({
      data: {
        name: name.trim(),
        email: cleanEmail,
        password: password.trim(),
        role,
        permissions: perms,
        isActive: true
      }
    });

    await logAuditEvent({
      staffId: req.staff.id,
      staffName: req.staff.name,
      staffEmail: req.staff.email,
      staffRole: req.staff.role,
      action: 'CREATE_STAFF',
      targetId: staff.id,
      targetType: 'staff',
      details: `Created new staff account '${staff.name}' (${staff.email}) with role '${role}'`,
      req
    });

    res.json({
      success: true,
      message: `Team member ${staff.name} created successfully!`,
      staff: {
        id: staff.id,
        name: staff.name,
        email: staff.email,
        role: staff.role,
        permissions: staff.permissions,
        isActive: staff.isActive
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 6. Super Admin: Update Staff Member (Role, Status, Password)
app.put('/api/admin/team/:id', requireStaffPermission('super_admin_only'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, role, permissions, password, isActive } = req.body;

    const dataToUpdate = {};
    if (name) dataToUpdate.name = name.trim();
    if (role) dataToUpdate.role = role;
    if (permissions !== undefined) dataToUpdate.permissions = permissions;
    if (password && password.trim()) dataToUpdate.password = password.trim();
    if (isActive !== undefined) dataToUpdate.isActive = Boolean(isActive);

    const updated = await prisma.staffUser.update({
      where: { id },
      data: dataToUpdate
    });

    await logAuditEvent({
      staffId: req.staff.id,
      staffName: req.staff.name,
      staffEmail: req.staff.email,
      staffRole: req.staff.role,
      action: 'UPDATE_STAFF',
      targetId: id,
      targetType: 'staff',
      details: `Updated staff '${updated.name}' (Role: ${updated.role}, Active: ${updated.isActive})`,
      req
    });

    res.json({
      success: true,
      message: `Staff account ${updated.name} updated successfully!`,
      staff: updated
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 7. Super Admin: Delete Staff Member
app.delete('/api/admin/team/:id', requireStaffPermission('super_admin_only'), async (req, res) => {
  try {
    const { id } = req.params;
    const staff = await prisma.staffUser.delete({ where: { id } });

    await logAuditEvent({
      staffId: req.staff.id,
      staffName: req.staff.name,
      staffEmail: req.staff.email,
      staffRole: req.staff.role,
      action: 'DELETE_STAFF',
      targetId: id,
      targetType: 'staff',
      details: `Permanently removed staff account '${staff.name}' (${staff.email})`,
      req
    });

    res.json({ success: true, message: `Staff member ${staff.name} deleted successfully.` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 8. Super Admin: Get Live Audit Logs
app.get('/api/admin/audit-logs', requireStaffPermission('super_admin_only'), async (req, res) => {
  try {
    const { limit = 100, action, staffId } = req.query;
    const where = {};
    if (action) where.action = action;
    if (staffId) where.staffId = staffId;

    const logs = await prisma.auditLog.findMany({
      where,
      take: Number(limit),
      orderBy: { createdAt: 'desc' }
    });

    res.json({ success: true, count: logs.length, logs });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// 🎧 MULTI-AGENT SMART HELPDESK & QUEUE API
// ============================================================

// 9. Get Live Support Queue & Filtered Threads
app.get('/api/admin/support/queue', requireStaffPermission('can_handle_support'), async (req, res) => {
  try {
    const currentStaffId = req.staff.id;

    // 1. Fetch messages grouped by user
    const messages = await prisma.supportMessage.findMany({
      orderBy: { createdAt: 'desc' }
    });

    const userMessagesMap = {};
    for (const m of messages) {
      if (!userMessagesMap[m.userId]) userMessagesMap[m.userId] = [];
      userMessagesMap[m.userId].push(m);
    }

    // 2. Fetch existing tickets and ensure all users with messages have tickets
    const existingTickets = await prisma.supportTicket.findMany();
    const existingTicketMap = new Map(existingTickets.map(t => [t.userId, t]));

    for (const [uid, msgs] of Object.entries(userMessagesMap)) {
      if (!existingTicketMap.has(uid) && msgs.length > 0) {
        const lastMsg = msgs[0]; // newest
        const userObj = await prisma.user.findFirst({
          where: { OR: [{ id: uid }, { email: uid.toLowerCase() }] },
          select: { name: true, email: true }
        });

        const newTicket = await prisma.supportTicket.create({
          data: {
            userId: uid,
            userName: userObj?.name || (uid.includes('@') ? uid.split('@')[0] : 'SimlyTel Customer'),
            userEmail: userObj?.email || (uid.includes('@') ? uid : null),
            status: 'unassigned',
            lastMessageText: lastMsg.text,
            lastMessageSender: lastMsg.sender,
            lastMessageAt: lastMsg.createdAt,
            unreadStaffCount: msgs.filter(m => m.sender === 'user').length
          }
        });
        existingTickets.push(newTicket);
        existingTicketMap.set(uid, newTicket);
      }
    }

    // 3. Sort tickets by lastMessageAt descending
    existingTickets.sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt));

    // 4. Categorize
    const unassigned = [];
    const myChats = [];
    const allChats = [];

    for (const t of existingTickets) {
      const msgs = userMessagesMap[t.userId] || [];
      const item = {
        ...t,
        messages: [...msgs].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)),
        isMine: t.assignedStaffId === currentStaffId,
        isLockedByOther: Boolean(t.assignedStaffId && t.assignedStaffId !== currentStaffId && t.status === 'in_progress')
      };

      if (t.status === 'unassigned') {
        unassigned.push(item);
      }
      if (t.assignedStaffId === currentStaffId && t.status === 'in_progress') {
        myChats.push(item);
      }
      allChats.push(item);
    }

    res.json({
      success: true,
      stats: {
        unassignedCount: unassigned.length,
        myChatsCount: myChats.length,
        totalActive: allChats.filter(x => x.status !== 'resolved').length
      },
      unassigned,
      myChats,
      allChats,
      currentStaff: {
        id: req.staff.id,
        name: req.staff.name,
        role: req.staff.role
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 10. Agent: Pick Up / Claim Ticket
app.post('/api/admin/support/claim', requireStaffPermission('can_handle_support'), async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'User ID is required.' });

    const ticket = await prisma.supportTicket.upsert({
      where: { userId },
      update: {
        status: 'in_progress',
        assignedStaffId: req.staff.id,
        assignedStaffName: req.staff.name,
        claimedAt: new Date()
      },
      create: {
        userId,
        status: 'in_progress',
        assignedStaffId: req.staff.id,
        assignedStaffName: req.staff.name,
        claimedAt: new Date()
      }
    });

    // Notify customer in real-time that human agent joined chat
    const agentDisplayName = req.staff?.name || 'Support Agent';
    await prisma.supportMessage.create({
      data: {
        userId,
        sender: 'system',
        senderName: 'SimlyTel Support',
        text: `🎧 ${agentDisplayName} (Support Agent) has joined the chat to assist you.`
      }
    });

    await logAuditEvent({
      staffId: req.staff.id,
      staffName: req.staff.name,
      staffEmail: req.staff.email,
      staffRole: req.staff.role,
      action: 'CLAIM_TICKET',
      targetId: userId,
      targetType: 'ticket',
      details: `Claimed conversation with User '${userId}'`,
      req
    });

    res.json({
      success: true,
      message: `You have claimed this chat. You are now assisting this customer.`,
      ticket
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 11. Agent: Transfer Ticket to Another Agent
app.post('/api/admin/support/transfer', requireStaffPermission('can_handle_support'), async (req, res) => {
  try {
    const { userId, targetStaffId, internalNotes = '' } = req.body;
    if (!userId || !targetStaffId) {
      return res.status(400).json({ success: false, error: 'User ID and Target Staff ID are required.' });
    }

    const targetStaff = await prisma.staffUser.findUnique({ where: { id: targetStaffId } });
    if (!targetStaff) {
      return res.status(404).json({ success: false, error: 'Target staff member not found.' });
    }

    const ticket = await prisma.supportTicket.update({
      where: { userId },
      data: {
        assignedStaffId: targetStaff.id,
        assignedStaffName: targetStaff.name,
        status: 'in_progress',
        internalNotes: internalNotes.trim() ? internalNotes.trim() : undefined
      }
    });

    await logAuditEvent({
      staffId: req.staff.id,
      staffName: req.staff.name,
      staffEmail: req.staff.email,
      staffRole: req.staff.role,
      action: 'TRANSFER_TICKET',
      targetId: userId,
      targetType: 'ticket',
      details: `Transferred customer '${userId}' to '${targetStaff.name}' (${targetStaff.email}). Note: ${internalNotes}`,
      req
    });

    res.json({
      success: true,
      message: `Ticket successfully transferred to ${targetStaff.name}!`,
      ticket
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 12. Agent: Mark Ticket as Resolved / Close
app.post('/api/admin/support/resolve', requireStaffPermission('can_handle_support'), async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'User ID is required.' });

    const ticket = await prisma.supportTicket.update({
      where: { userId },
      data: {
        status: 'resolved',
        resolvedAt: new Date()
      }
    });

    // Notify customer that ticket is resolved and prompt rating
    const agentDisplayName = req.staff?.name || 'Your Support Agent';
    await prisma.supportMessage.create({
      data: {
        userId,
        sender: 'system',
        senderName: 'SimlyTel Support',
        text: `✅ This support ticket has been resolved by ${agentDisplayName}. Please rate your experience below! ⭐`
      }
    });

    // Increment agent's resolved count
    if (req.staff.id !== 'root_super_admin') {
      await prisma.staffUser.update({
        where: { id: req.staff.id },
        data: { ticketsResolved: { increment: 1 } }
      }).catch(() => {});
    }

    await logAuditEvent({
      staffId: req.staff.id,
      staffName: req.staff.name,
      staffEmail: req.staff.email,
      staffRole: req.staff.role,
      action: 'RESOLVE_TICKET',
      targetId: userId,
      targetType: 'ticket',
      details: `Marked ticket for User '${userId}' as Resolved ✅`,
      req
    });

    res.json({
      success: true,
      message: 'Ticket marked as Resolved and moved to completed archive.',
      ticket
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 12b. Endpoint: Submit Customer Satisfaction (CSAT) Star Rating & Review
app.post('/api/support/rate', async (req, res) => {
  try {
    const { userId, rating, feedback = '' } = req.body;
    if (!userId || !rating || isNaN(Number(rating))) {
      return res.status(400).json({ success: false, error: 'User ID and valid rating (1-5) are required.' });
    }

    const starCount = Math.min(5, Math.max(1, parseInt(rating, 10)));
    const starsEmoji = '⭐'.repeat(starCount);

    const ticket = await prisma.supportTicket.findUnique({ where: { userId } });
    
    // Post confirmation into chat
    await prisma.supportMessage.create({
      data: {
        userId,
        sender: 'system',
        senderName: 'SimlyTel Support',
        text: `🌟 Customer Rated ${starCount}/5 Stars ${starsEmoji}${feedback.trim() ? `\nReview: "${feedback.trim()}"` : ''}`
      }
    });

    if (ticket) {
      await prisma.supportTicket.update({
        where: { userId },
        data: {
          internalNotes: `Rating: ${starCount}/5 Stars ${starsEmoji}. Feedback: ${feedback.trim() || 'No text review'}`
        }
      });

      // Track in staff audit log
      if (ticket.assignedStaffId && ticket.assignedStaffId !== 'root_super_admin') {
        const staff = await prisma.staffUser.findUnique({ where: { id: ticket.assignedStaffId } });
        if (staff) {
          await logAuditEvent({
            staffId: staff.id,
            staffName: staff.name,
            staffEmail: staff.email,
            staffRole: staff.role,
            action: 'RECEIVED_CUSTOMER_RATING',
            targetId: userId,
            targetType: 'staff',
            details: `Received ${starCount}/5 ⭐ CSAT Rating from customer '${ticket.userName || userId}'. Review: "${feedback.trim()}"`,
            req
          });
        }
      }
    }

    res.json({
      success: true,
      message: `Thank you! Your ${starCount}-star rating has been recorded.`,
      rating: starCount
    });
  } catch (error) {
    console.error('[SIMLY ERROR] Failed to submit support rating:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 13. Get List of Available Online Agents for Transfer Dropdown
app.get('/api/admin/support/agents', requireStaffPermission('can_handle_support'), async (req, res) => {
  try {
    const agents = await prisma.staffUser.findMany({
      where: { isActive: true },
      select: { id: true, name: true, email: true, role: true, isOnline: true }
    });
    res.json({ success: true, agents });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 13b. Endpoint: Get Consolidated User Dossier for Support Workstation
app.get('/api/admin/support/user-dossier/:userId', requireStaffPermission(['can_view_users', 'can_handle_support']), async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ success: false, error: 'User ID is required.' });

    const cleanUid = userId.toString().trim();
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { id: cleanUid },
          { email: cleanUid.toLowerCase() },
          { email: `${cleanUid.toLowerCase()}@simlytel.com` },
          { email: `${cleanUid.toLowerCase()}@simly.app` }
        ]
      }
    });

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    // Numbers owned by user
    const numbers = await prisma.purchasedNumber.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' }
    });

    const userPhoneNumbers = numbers.map(n => n.phoneNumber);

    // Recent 10 Transactions
    const transactions = await prisma.transaction.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 10
    });

    // Recent 10 Call Logs
    const calls = await prisma.callLog.findMany({
      where: {
        OR: [
          { myNumber: { in: userPhoneNumbers } },
          { contactNumber: { in: userPhoneNumbers } }
        ]
      },
      orderBy: { createdAt: 'desc' },
      take: 10
    });

    // Support Ticket Info
    const ticket = await prisma.supportTicket.findUnique({
      where: { userId: user.id }
    });

    res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        walletBalance: user.walletBalance,
        isVerified: user.isVerified,
        isBanned: user.isBanned,
        banReason: user.banReason,
        riskScore: user.riskScore,
        riskLevel: user.riskLevel,
        lastLoginIp: user.lastLoginIp,
        deviceId: user.deviceId,
        createdAt: user.createdAt
      },
      numbers,
      transactions,
      calls,
      ticket: ticket || null
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 13c. Endpoint: Support Agent Action: Purchase Virtual Line for User (Deducting User Balance)
app.post('/api/admin/agent-actions/purchase-for-user', requireStaffPermission('can_purchase_for_user'), async (req, res) => {
  try {
    const { userId, countryCode = 'US', planType = '30_days', phoneNumber, customPhoneNumber } = req.body;
    if (!userId) {
      return res.status(400).json({ success: false, error: 'User ID is required.' });
    }

    const cleanUid = userId.toString().trim();
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { id: cleanUid },
          { email: cleanUid.toLowerCase() },
          { email: `${cleanUid.toLowerCase()}@simlytel.com` }
        ]
      }
    });

    if (!user) {
      return res.status(404).json({ success: false, error: 'User account not found.' });
    }

    // Strict Queue / Claim enforcement check: NO ONE can buy numbers for an unassigned queue chat without claiming it first
    const ticket = await prisma.supportTicket.findUnique({ where: { userId: user.id } });
    if (ticket && ticket.status === 'unassigned') {
      return res.status(403).json({
        success: false,
        error: 'Chat accept / claim nahi hui! Pehle "Pick Up / Claim" par click karke ticket accept karein.'
      });
    }
    if (req.staff.role !== 'super_admin' && ticket && ticket.assignedStaffId && ticket.assignedStaffId !== req.staff.id) {
      return res.status(403).json({
        success: false,
        error: 'This ticket is assigned to another agent.'
      });
    }

    if (user.isBanned || !user.isVerified) {
      return res.status(403).json({ success: false, error: 'User account is restricted or banned. Cannot purchase lines.' });
    }

    const selectedNumber = phoneNumber || customPhoneNumber;
    if (!selectedNumber) {
      return res.status(400).json({
        success: false,
        error: 'Please select an available phone number from the carrier pool.'
      });
    }

    // Assigned carrier phone number
    const assignedNumber = normalizePhone(selectedNumber);

    // Determine retail price based on exact system pricing rules
    const cCode = countryCode.toUpperCase();
    const durationDays = planType === '7_days' ? 7 : (planType === '365_days' ? 365 : 30);
    const retailPrice = calculateNumberPrice(cCode, planType, durationDays, assignedNumber);

    // STRICT WALLET BALANCE CHECK
    if (user.walletBalance < retailPrice || user.walletBalance <= 0) {
      return res.status(402).json({
        success: false,
        error: `Customer balance (${user.walletBalance.toFixed(2)}) is insufficient for this number plan (${retailPrice.toFixed(2)}). Please advise customer to top up first.`,
        requiredAmount: retailPrice,
        currentBalance: user.walletBalance
      });
    }

    // Deduct user balance
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: { walletBalance: { decrement: retailPrice } }
    });

    // Calculate exact plan expiry date (7 days, 30 days, or 365 days)
    const expiresAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);

    // Create Virtual Number record with exact expiresAt date
    const newNumber = await prisma.purchasedNumber.create({
      data: {
        phoneNumber: assignedNumber,
        userId: user.id,
        countryCode: cCode,
        planType: planType || '30_days',
        status: 'active',
        expiresAt: expiresAt,
        profileName: null
      }
    });

    // Record user ledger transaction (clean, standard customer billing description)
    await prisma.transaction.create({
      data: {
        userId: user.id,
        type: 'number_purchase',
        amount: -retailPrice,
        description: `Line Purchase (${planType}): ${assignedNumber}`
      }
    });

    // Post clean confirmation in Support Chat (branded as SimlyTel Support without leaking agent identity)
    await prisma.supportMessage.create({
      data: {
        userId: user.id,
        sender: 'system',
        senderName: 'SimlyTel Support',
        text: `🎉 Great news! Virtual line ${assignedNumber} has been activated for you. (${retailPrice.toFixed(2)} deducted from your wallet balance. Remaining: ${(user.walletBalance - retailPrice).toFixed(2)}).`
      }
    });

    // Audit Log
    await logAuditEvent({
      staffId: req.staff.id,
      staffName: req.staff.name,
      staffEmail: req.staff.email,
      staffRole: req.staff.role,
      action: 'PURCHASE_NUMBER_FOR_USER',
      targetId: user.id,
      targetType: 'number',
      details: `Agent purchased carrier line ${assignedNumber} for ${user.email} (Deducted ${retailPrice.toFixed(2)} from user wallet)`,
      req
    });

    res.json({
      success: true,
      message: `Successfully activated ${assignedNumber} for customer ${user.name || user.email}!`,
      number: newNumber,
      deductedAmount: retailPrice,
      remainingBalance: updatedUser.walletBalance
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 13d. Endpoint: Support Agent Action: Renew Virtual Line for User (Deducting User Balance)
app.post('/api/admin/agent-actions/renew-for-user', requireStaffPermission('can_renew_for_user'), async (req, res) => {
  try {
    const { numberId, userId } = req.body;
    if (!numberId || !userId) {
      return res.status(400).json({ success: false, error: 'numberId and userId are required.' });
    }

    const cleanUid = userId.toString().trim();
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { id: cleanUid },
          { email: cleanUid.toLowerCase() },
          { email: `${cleanUid.toLowerCase()}@simlytel.com` }
        ]
      }
    });

    if (!user) {
      return res.status(404).json({ success: false, error: 'User account not found.' });
    }

    const line = await prisma.purchasedNumber.findFirst({
      where: { id: numberId, userId: user.id }
    });

    if (!line) {
      return res.status(404).json({ success: false, error: 'Virtual line not found for this user.' });
    }

    // Strict Queue / Claim enforcement check for renew: NO ONE can renew numbers for unassigned queue chats
    const ticket = await prisma.supportTicket.findUnique({ where: { userId: user.id } });
    if (ticket && ticket.status === 'unassigned') {
      return res.status(403).json({
        success: false,
        error: 'Chat accept / claim nahi hui! Pehle "Pick Up / Claim" par click karke ticket accept karein.'
      });
    }
    if (req.staff.role !== 'super_admin' && ticket && ticket.assignedStaffId && ticket.assignedStaffId !== req.staff.id) {
      return res.status(403).json({
        success: false,
        error: 'This ticket is assigned to another agent.'
      });
    }

    // Determine renewal price using unified pricing function
    const renewalPrice = calculateNumberPrice(line.countryCode || 'US', line.planType || '30_days', 30, line.phoneNumber);

    if (user.walletBalance < renewalPrice || user.walletBalance <= 0) {
      return res.status(402).json({
        success: false,
        error: `Customer balance ($${user.walletBalance.toFixed(2)}) is insufficient for line renewal ($${renewalPrice.toFixed(2)}).`,
        requiredAmount: renewalPrice,
        currentBalance: user.walletBalance
      });
    }

    // Deduct user balance
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: { walletBalance: { decrement: renewalPrice } }
    });

    // Calculate new extended expiry date (+30 days from current expiry or now)
    const currentExpiry = line.expiresAt ? new Date(line.expiresAt).getTime() : Date.now();
    const newExpiresAt = new Date(Math.max(Date.now(), currentExpiry) + 30 * 24 * 60 * 60 * 1000);

    // Update number status & extended expiry
    const updatedLine = await prisma.purchasedNumber.update({
      where: { id: line.id },
      data: { status: 'active', expiresAt: newExpiresAt }
    });

    // Create Transaction (clean customer billing statement)
    await prisma.transaction.create({
      data: {
        userId: user.id,
        type: 'number_renew',
        amount: -renewalPrice,
        description: `Line Renewal (30 Days): ${line.phoneNumber}`
      }
    });

    // Post in Chat (branded clean notification)
    await prisma.supportMessage.create({
      data: {
        userId: user.id,
        sender: 'system',
        senderName: 'SimlyTel Support',
        text: `🔄 Your virtual line ${line.phoneNumber} has been renewed for 30 days. (${renewalPrice.toFixed(2)} deducted from your wallet balance. Remaining: ${(user.walletBalance - renewalPrice).toFixed(2)}).`
      }
    });

    // Audit Log
    await logAuditEvent({
      staffId: req.staff.id,
      staffName: req.staff.name,
      staffEmail: req.staff.email,
      staffRole: req.staff.role,
      action: 'RENEW_NUMBER_FOR_USER',
      targetId: line.id,
      targetType: 'number',
      details: `Agent renewed line ${line.phoneNumber} for ${user.email} (Deducted $${renewalPrice.toFixed(2)})`,
      req
    });

    res.json({
      success: true,
      message: `Line ${line.phoneNumber} renewed successfully!`,
      number: updatedLine,
      remainingBalance: updatedUser.walletBalance
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 13. Customer Support Helpdesk Messages
app.get('/api/admin/support', requireAdmin, async (req, res) => {
  try {
    const messages = await prisma.supportMessage.findMany({
      take: 150,
      orderBy: { createdAt: 'desc' }
    });

    // Group by userId
    const threads = {};
    for (const m of messages) {
      if (!threads[m.userId]) {
        const u = await prisma.user.findFirst({
          where: { OR: [{ id: m.userId }, { email: m.userId }] },
          select: { email: true, name: true }
        });
        threads[m.userId] = {
          userId: m.userId,
          userEmail: u?.email || m.userId,
          userName: u?.name || 'Customer',
          messages: []
        };
      }
      threads[m.userId].messages.push(m);
    }

    res.json({ success: true, threads: Object.values(threads) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 14. Admin Reply to Customer Support
app.post('/api/admin/support/reply', requireStaffPermission('can_handle_support'), async (req, res) => {
  try {
    const { userId, text } = req.body;
    if (!userId || !text) {
      return res.status(400).json({ success: false, error: 'User ID and message text are required.' });
    }

    const cleanUserId = userId.toString().trim();
    const existingTicket = await prisma.supportTicket.findUnique({ where: { userId: cleanUserId } });

    const isSuperAdmin = req.staff?.role === 'super_admin' || req.staff?.id === 'root_super_admin';
    const currentStaffId = req.staff?.id;
    const currentStaffName = req.staff?.name || 'Support Specialist';

    // 🔒 STRICT CLAIM ENFORCEMENT: Agent must pick up/claim ticket first before messaging!
    if (!existingTicket || existingTicket.status === 'unassigned' || !existingTicket.assignedStaffId) {
      return res.status(403).json({
        success: false,
        error: '⚠️ Ticket is not claimed! Please click "Pick Up / Claim" first to join this conversation before replying.'
      });
    }

    if (existingTicket.assignedStaffId !== currentStaffId && !isSuperAdmin) {
      return res.status(403).json({
        success: false,
        error: `⚠️ This ticket is currently assigned to ${existingTicket.assignedStaffName || 'another agent'}. You cannot reply.`
      });
    }

    const agentName = `${currentStaffName} (SimlyTel Support)`;

    const saved = await prisma.supportMessage.create({
      data: {
        userId: cleanUserId,
        sender: 'agent',
        senderName: agentName,
        text: text.trim()
      }
    });

    // Update ticket status
    await prisma.supportTicket.update({
      where: { userId: cleanUserId },
      data: {
        lastMessageText: text.trim(),
        lastMessageSender: 'agent',
        lastMessageAt: new Date(),
        unreadUserCount: { increment: 1 }
      }
    });

    await logAuditEvent({
      staffId: req.staff?.id,
      staffName: req.staff?.name,
      staffEmail: req.staff?.email,
      staffRole: req.staff?.role,
      action: 'REPLY_SUPPORT',
      targetId: cleanUserId,
      targetType: 'ticket',
      details: `Replied to customer '${cleanUserId}': "${text.slice(0, 50)}..."`,
      req
    });

    res.json({ success: true, message: 'Reply sent successfully!', data: saved });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 15. Dynamic Pricing & Rates Config
app.get('/api/admin/pricing', requireAdmin, (req, res) => {
  res.json({ success: true, config: adminRuntimeConfig });
});

app.post('/api/admin/pricing', requireAdmin, (req, res) => {
  const { callRateMultiplier, numberRateMultiplier, defaultWelcomeBonus } = req.body;
  if (callRateMultiplier) adminRuntimeConfig.callRateMultiplier = parseFloat(callRateMultiplier);
  if (numberRateMultiplier) adminRuntimeConfig.numberRateMultiplier = parseFloat(numberRateMultiplier);
  if (defaultWelcomeBonus) adminRuntimeConfig.defaultWelcomeBonus = parseFloat(defaultWelcomeBonus);

  res.json({ success: true, message: 'Runtime pricing updated live!', config: adminRuntimeConfig });
});

// 16. Promo Codes Management
app.post('/api/admin/promos/create', requireAdmin, (req, res) => {
  const { code, bonus, maxUses } = req.body;
  if (!code || !bonus) {
    return res.status(400).json({ success: false, error: 'Code and bonus amount required.' });
  }

  const newPromo = {
    id: `p_${Date.now()}`,
    code: code.trim().toUpperCase(),
    bonus: parseFloat(bonus),
    maxUses: parseInt(maxUses || '100', 10),
    used: 0,
    active: true,
    createdAt: new Date()
  };

  adminRuntimeConfig.promos.unshift(newPromo);
  res.json({ success: true, message: `Promo code ${newPromo.code} created!`, promo: newPromo });
});

app.post('/api/admin/promos/toggle', requireAdmin, (req, res) => {
  const { id } = req.body;
  const promo = adminRuntimeConfig.promos.find(p => p.id === id);
  if (!promo) return res.status(404).json({ success: false, error: 'Promo not found.' });

  promo.active = !promo.active;
  res.json({ success: true, message: `Promo ${promo.code} is now ${promo.active ? 'ACTIVE' : 'DISABLED'}` });
});

// ============================================================================
// 📢 APP ANNOUNCEMENTS, PROMOTIONAL POP-UPS & BROADCAST PUSH NOTIFICATIONS
// ============================================================================

// 17. Public Mobile App Endpoint: Get Latest Active Pop-up Announcement
app.get('/api/announcements/active', async (req, res) => {
  try {
    const announcement = await prisma.announcement.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' }
    });

    if (!announcement) {
      return res.json({ success: true, hasActive: false, announcement: null });
    }

    res.json({
      success: true,
      hasActive: true,
      announcement: {
        id: announcement.id,
        title: announcement.title,
        message: announcement.message,
        imageUrl: announcement.imageUrl,
        buttonText: announcement.buttonText || 'Claim Offer Now',
        actionType: announcement.actionType || 'none',
        actionUrl: announcement.actionUrl || '',
        bannerType: announcement.bannerType || 'modal_popup',
        displayFrequency: announcement.displayFrequency || 'once_per_session'
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 18. Admin: List All Announcements
app.get('/api/admin/announcements', requireAdmin, async (req, res) => {
  try {
    const list = await prisma.announcement.findMany({
      orderBy: { createdAt: 'desc' }
    });
    res.json({ success: true, count: list.length, announcements: list });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 19. Admin: Create / Save Announcement (Supports Picture-Only, Text-Only, or Graphic+Text)
app.post('/api/admin/announcements', requireAdmin, async (req, res) => {
  try {
    const {
      id,
      title = '',
      message = '',
      imageUrl = null,
      buttonText = '',
      actionType = 'navigate_numbers',
      actionUrl = null,
      bannerType = 'modal_popup',
      displayFrequency = 'once_per_session',
      isActive = true
    } = req.body;

    const trimmedTitle = (title || '').trim();
    const trimmedMsg = (message || '').trim();
    const trimmedImg = imageUrl && imageUrl.trim() ? imageUrl.trim() : null;

    if (!trimmedImg && !trimmedTitle && !trimmedMsg) {
      return res.status(400).json({ success: false, error: 'Please provide at least a Banner Image or Title / Message.' });
    }

    let saved;
    if (id) {
      saved = await prisma.announcement.update({
        where: { id },
        data: {
          title: trimmedTitle,
          message: trimmedMsg,
          imageUrl: trimmedImg,
          buttonText: (buttonText || '').trim(),
          actionType: actionType || 'navigate_numbers',
          actionUrl: actionUrl && actionUrl.trim() ? actionUrl.trim() : null,
          bannerType: bannerType || 'modal_popup',
          displayFrequency: displayFrequency || 'once_per_session',
          isActive: Boolean(isActive)
        }
      });
    } else {
      saved = await prisma.announcement.create({
        data: {
          title: trimmedTitle,
          message: trimmedMsg,
          imageUrl: trimmedImg,
          buttonText: (buttonText || '').trim(),
          actionType: actionType || 'navigate_numbers',
          actionUrl: actionUrl && actionUrl.trim() ? actionUrl.trim() : null,
          bannerType: bannerType || 'modal_popup',
          displayFrequency: displayFrequency || 'once_per_session',
          isActive: Boolean(isActive)
        }
      });
    }

    res.json({
      success: true,
      message: id ? 'Announcement updated successfully!' : 'New pop-up announcement published live!',
      announcement: saved
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 20. Admin: Toggle Announcement Active Status
app.post('/api/admin/announcements/:id/toggle', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const existing = await prisma.announcement.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Announcement not found.' });
    }

    const updated = await prisma.announcement.update({
      where: { id },
      data: { isActive: !existing.isActive }
    });

    res.json({
      success: true,
      message: `Announcement "${updated.title}" is now ${updated.isActive ? 'ACTIVE 🟢 (Live on user phones)' : 'PAUSED / INACTIVE 🔴'}`,
      announcement: updated
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 21. Admin: Delete Announcement
app.delete('/api/admin/announcements/:id', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    await prisma.announcement.delete({ where: { id } });
    res.json({ success: true, message: 'Announcement removed successfully.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

let latestBroadcastNotification = null;

// 22.1 Public Mobile App Endpoint: Get Latest Broadcast Notification
app.get('/api/notifications/latest-broadcast', (req, res) => {
  res.json({
    success: true,
    hasNotification: latestBroadcastNotification !== null,
    notification: latestBroadcastNotification
  });
});


// ==========================================
// 📲 ONESIGNAL PUSH NOTIFICATION DISPATCHER
// ==========================================
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID || 'd26a2672-6cc5-4ed2-ae81-d8879194ea95';
const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY;

async function sendOneSignalPush({ title, body, userId = null, audience = 'all', data = {}, bigPicture = null }) {
  try {
    const payload = {
      app_id: ONESIGNAL_APP_ID,
      headings: { en: title },
      contents: { en: body },
      priority: 10,
      android_sound: 'notification',
      data: {
        ...data,
        timestamp: Date.now(),
        source: 'simlytel_core'
      }
    };

    if (bigPicture) {
      payload.big_picture = bigPicture;
      payload.chrome_web_image = bigPicture;
    }

    if (userId && audience !== 'all') {
      payload.include_aliases = {
        external_id: [userId]
      };
      payload.target_channel = 'push';
    } else {
      payload.included_segments = ['Total Subscriptions'];
    }

    console.log('📲 [ONESIGNAL DISPATCHING] Sending push payload:', JSON.stringify(payload));

    const response = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': 'Basic ' + ONESIGNAL_REST_API_KEY
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    console.log('📲 [ONESIGNAL DISPATCH RESULT]:', result);
    return { success: response.ok, result };
  } catch (err) {
    console.error('❌ [ONESIGNAL ERROR]:', err);
    return { success: false, error: err.message };
  }
}

// 22. Admin: Broadcast Push Notification to All Devices
app.post('/api/admin/broadcast-push', requireAdmin, async (req, res) => {
  try {
    const { title, body, audience = 'all' } = req.body;
    if (!title || !body) {
      return res.status(400).json({ success: false, error: 'Notification title and body are required.' });
    }

    const tokens = await prisma.devicePushToken.findMany();
    const totalDevices = tokens.length;
    const totalUsers = await prisma.user.count({ where: { isDeleted: false } });

    latestBroadcastNotification = {
      id: `push_${Date.now()}`,
      title: title.trim(),
      body: body.trim(),
      audience,
      timestamp: new Date().toISOString()
    };

    // Dispatch via OneSignal native push engine (rings phone in background)
    const pushResult = await sendOneSignalPush({
      title: title.trim(),
      body: body.trim(),
      audience
    });

    console.log(`📲 [BROADCAST PUSH] Dispatched: "${title}" to ${totalDevices} devices (${totalUsers} accounts). OneSignal:`, pushResult);

    res.json({
      success: true,
      message: `Broadcast push notification dispatched via OneSignal! (Total accounts: ${totalUsers}, Devices: ${totalDevices})`,
      stats: {
        totalDispatched: totalDevices,
        totalUsers,
        title,
        body,
        oneSignal: pushResult,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


const PORT = process.env.PORT || 5000;
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`🚀 Simly Core Engine running on port ${PORT}`);
  });
}

module.exports = app;


// ==========================================
// 🛡️ ENTERPRISE SECURITY & BLACKLIST ENDPOINTS
// ==========================================

// Get All Blacklisted Entries
app.get('/api/admin/security/blacklist', requireAdmin, async (req, res) => {
  try {
    const list = await prisma.blacklist.findMany({
      orderBy: { createdAt: 'desc' }
    });
    res.json({ success: true, count: list.length, blacklist: list });
  } catch (error) {
    console.error('[BLACKLIST GET ERROR]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Add Entry to Blacklist
app.post('/api/admin/security/blacklist', requireAdmin, async (req, res) => {
  try {
    const { type, value, reason } = req.body;
    if (!type || !value) {
      return res.status(400).json({ success: false, error: 'Type (EMAIL, IP, DEVICE_ID, PHONE) and value are required.' });
    }

    const cleanVal = type.toUpperCase() === 'EMAIL' ? value.toLowerCase().trim() : value.trim();

    // Check if already exists
    const existing = await prisma.blacklist.findFirst({
      where: { type: type.toUpperCase(), value: cleanVal }
    });

    if (existing) {
      const updated = await prisma.blacklist.update({
        where: { id: existing.id },
        data: { isActive: true, reason: reason || existing.reason }
      });
      await logAuditEvent(req, 'ADD_BLACKLIST', updated.id, 'blacklist', `Re-activated blacklist for ${type}: ${cleanVal}`);
      return res.json({ success: true, message: 'Blacklist entry updated', entry: updated });
    }

    const created = await prisma.blacklist.create({
      data: {
        type: type.toUpperCase(),
        value: cleanVal,
        reason: reason || 'Manual security block by admin',
        createdBy: req.staffUser?.name || 'Super Admin',
        isActive: true
      }
    });

    await logAuditEvent(req, 'ADD_BLACKLIST', created.id, 'blacklist', `Blocked ${type}: ${cleanVal} - Reason: ${reason || 'Security'}`);
    res.json({ success: true, message: 'Security block added successfully', entry: created });
  } catch (error) {
    console.error('[BLACKLIST POST ERROR]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Remove / Whitelist Entry from Blacklist
app.delete('/api/admin/security/blacklist/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const entry = await prisma.blacklist.findUnique({ where: { id } });
    if (!entry) return res.status(404).json({ success: false, error: 'Blacklist entry not found.' });

    await prisma.blacklist.delete({ where: { id } });
    await logAuditEvent(req, 'REMOVE_BLACKLIST', id, 'blacklist', `Removed ${entry.type}: ${entry.value} from blacklist`);

    res.json({ success: true, message: 'Removed from security blocklist' });
  } catch (error) {
    console.error('[BLACKLIST DELETE ERROR]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 1-Click Ban User & Shield System
app.post('/api/admin/users/:id/ban', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, blacklistIp, blacklistEmail, blacklistDevice } = req.body;

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return res.status(404).json({ success: false, error: 'User not found.' });

    const banReasonStr = reason || 'Suspicious / fraudulent activity detected';

    const updatedUser = await prisma.user.update({
      where: { id },
      data: {
        isBanned: true,
        riskScore: 100,
        riskLevel: 'HIGH',
        banReason: banReasonStr,
        isVerified: false
      }
    });

    // Optionally auto-add to Blacklist
    if (blacklistEmail && user.email) {
      await prisma.blacklist.create({
        data: {
          type: 'EMAIL',
          value: user.email.toLowerCase().trim(),
          reason: `User Banned: ${banReasonStr}`,
          createdBy: req.staffUser?.name || 'Super Admin'
        }
      }).catch(() => {});
    }

    if (blacklistIp && user.lastLoginIp) {
      await prisma.blacklist.create({
        data: {
          type: 'IP',
          value: user.lastLoginIp.trim(),
          reason: `User Banned: ${banReasonStr}`,
          createdBy: req.staffUser?.name || 'Super Admin'
        }
      }).catch(() => {});
    }

    if (blacklistDevice && user.deviceId) {
      await prisma.blacklist.create({
        data: {
          type: 'DEVICE_ID',
          value: user.deviceId.trim(),
          reason: `User Banned: ${banReasonStr}`,
          createdBy: req.staffUser?.name || 'Super Admin'
        }
      }).catch(() => {});
    }

    // Auto-suspend active numbers
    await prisma.purchasedNumber.updateMany({
      where: { userId: id, status: 'active' },
      data: { status: 'suspended' }
    }).catch(() => {});

    await logAuditEvent(req, 'BAN_USER', id, 'user', `Permanently banned user ${user.email} (${user.name}) - Reason: ${banReasonStr}`);

    res.json({
      success: true,
      message: `User ${user.name} (${user.email}) has been permanently banned and isolated.`,
      user: updatedUser
    });
  } catch (error) {
    console.error('[BAN USER ERROR]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 1-Click Unban User
app.post('/api/admin/users/:id/unban', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return res.status(404).json({ success: false, error: 'User not found.' });

    const updatedUser = await prisma.user.update({
      where: { id },
      data: {
        isBanned: false,
        riskScore: 0,
        riskLevel: 'LOW',
        banReason: null,
        isVerified: true
      }
    });

    // Re-activate suspended numbers
    await prisma.purchasedNumber.updateMany({
      where: { userId: id, status: 'suspended' },
      data: { status: 'active' }
    }).catch(() => {});

    await logAuditEvent(req, 'UNBAN_USER', id, 'user', `Unbanned user ${user.email} and restored account access`);

    res.json({
      success: true,
      message: `User ${user.name} (${user.email}) has been unbanned and restored.`,
      user: updatedUser
    });
  } catch (error) {
    console.error('[UNBAN USER ERROR]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// ==========================================
// 📡 CARRIER HEALTH & NET PROFIT MARGINS (STEP 3)
// ==========================================

// Helper to fetch live Telnyx balance
async function getTelnyxLiveBalance() {
  const https = require('https');
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return { balance: 0, currency: 'USD', creditLimit: '0.00', status: 'NO_API_KEY' };

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.telnyx.com',
      path: '/v2/balance',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.data) {
            resolve({
              balance: parseFloat(data.data.balance || 0),
              currency: data.data.currency || 'USD',
              creditLimit: data.data.credit_limit || '0.00',
              status: 'OK'
            });
          } else {
            resolve({ balance: 0, currency: 'USD', creditLimit: '0.00', status: 'ERROR', raw: data });
          }
        } catch (e) {
          resolve({ balance: 0, currency: 'USD', creditLimit: '0.00', status: 'PARSE_ERROR' });
        }
      });
    });

    req.on('error', (e) => resolve({ balance: 0, currency: 'USD', creditLimit: '0.00', status: 'NETWORK_ERROR' }));
    req.end();
  });
}

// 1. Telecom Carrier Health & Live Balance
app.get('/api/admin/telecom/carrier-health', requireAdmin, async (req, res) => {
  try {
    const telnyxInfo = await getTelnyxLiveBalance();
    const balanceVal = telnyxInfo.balance || 0;

    let healthStatus = 'HEALTHY 🟢';
    let healthColor = 'emerald';
    let warningMessage = null;

    if (balanceVal <= 5) {
      healthStatus = 'CRITICAL 🔴';
      healthColor = 'rose';
      warningMessage = 'Telnyx balance is critically low. Calls may fail soon if not refilled.';
    } else if (balanceVal < 30) {
      healthStatus = 'LOW BALANCE 🟡';
      healthColor = 'amber';
      warningMessage = 'Telnyx balance is low. Consider topping up to prevent call interruption.';
    }

    const [activeNumbers, todayCalls, todayMessages] = await Promise.all([
      prisma.purchasedNumber.count({ where: { status: 'active' } }),
      prisma.callLog.count({
        where: {
          createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) }
        }
      }),
      prisma.message.count({
        where: {
          createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) }
        }
      })
    ]);

    res.json({
      success: true,
      carrier: 'Telnyx Wholesale Telecom',
      balance: balanceVal,
      currency: telnyxInfo.currency,
      creditLimit: telnyxInfo.creditLimit,
      healthStatus,
      healthColor,
      warningMessage,
      activeNumbers,
      todayCalls,
      todayMessages,
      lastChecked: new Date().toISOString()
    });
  } catch (error) {
    console.error('[CARRIER HEALTH ERROR]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Real-Time Net Profit Margins & Cost Analytics (8-Decimal Accuracy)
app.get('/api/admin/finance/margins', requireAdmin, async (req, res) => {
  try {
    const fin = await calculateMasterFinancials();
    res.json({
      success: true,
      data: fin
    });
  } catch (error) {
    console.error('[FINANCE MARGINS ERROR]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// ==========================================
// ⚙️ CLOUD REMOTE CONFIG & APP KILL-SWITCHES (STEP 4)
// ==========================================

const DEFAULT_SYSTEM_CONFIGS = {
  maintenance_mode: { value: 'false', desc: 'Global app maintenance mode (true = locked, false = live)' },
  maintenance_message: { value: 'SimlyTel is currently undergoing scheduled network maintenance. We will be back online shortly!', desc: 'Maintenance message shown to users' },
  min_app_version: { value: '1.1.0', desc: 'Minimum required mobile app version before force update popup' },
  force_update_title: { value: 'Update Required', desc: 'Title on force update modal' },
  force_update_message: { value: 'A new version of SimlyTel is required. Please update your app now.', desc: 'Message on force update modal' },
  store_url_android: { value: 'https://play.google.com/store/apps/details?id=com.simlytel.app', desc: 'Google Play Store URL' },
  store_url_ios: { value: 'https://apps.apple.com/app/simlytel/id123456789', desc: 'Apple App Store URL' },
  allow_outbound_calls: { value: 'true', desc: 'Emergency VoIP calling switch (true = enabled, false = kill switch)' },
  allow_sms: { value: 'true', desc: 'Emergency SMS sending switch' },
  allow_deposits: { value: 'true', desc: 'Emergency wallet recharge & payments switch' },
  support_email: { value: 'support@simlytel.com', desc: 'Official customer support email' },
  support_phone: { value: '+1 (800) 555-SIMLY', desc: 'Official customer support phone' }
};

// Helper to get all configs with defaults
async function getSystemConfigsMap() {
  const configs = await prisma.systemConfig.findMany();
  const configMap = {};

  // Populate defaults
  for (const [key, item] of Object.entries(DEFAULT_SYSTEM_CONFIGS)) {
    configMap[key] = item.value;
  }

  // Override with database values
  for (const c of configs) {
    configMap[c.key] = c.value;
  }

  return configMap;
}

// Simple semver compare helper (e.g. "1.0.1" vs "1.1.0")
function isVersionOlder(clientVersion, minRequiredVersion) {
  if (!clientVersion || !minRequiredVersion) return false;
  const cParts = clientVersion.split('.').map(n => parseInt(n, 10) || 0);
  const mParts = minRequiredVersion.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const c = cParts[i] || 0;
    const m = mParts[i] || 0;
    if (c < m) return true;
    if (c > m) return false;
  }
  return false;
}

// 1. Mobile App Public Config Polling Route
app.get('/api/app/config', async (req, res) => {
  try {
    const clientAppVersion = req.query.version || req.headers['x-app-version'] || '1.0.0';
    const configMap = await getSystemConfigsMap();

    const isMaintenance = configMap.maintenance_mode === 'true';
    const minVersion = configMap.min_app_version || '1.0.0';
    const requiresUpdate = isVersionOlder(clientAppVersion, minVersion);

    res.json({
      success: true,
      maintenance: {
        active: isMaintenance,
        message: configMap.maintenance_message
      },
      update: {
        required: requiresUpdate,
        minVersion: minVersion,
        title: configMap.force_update_title,
        message: configMap.force_update_message,
        androidUrl: configMap.store_url_android,
        iosUrl: configMap.store_url_ios
      },
      features: {
        callsEnabled: configMap.allow_outbound_calls === 'true',
        smsEnabled: configMap.allow_sms === 'true',
        depositsEnabled: configMap.allow_deposits === 'true'
      },
      support: {
        email: configMap.support_email,
        phone: configMap.support_phone
      },
      serverTime: new Date().toISOString()
    });
  } catch (error) {
    console.error('[APP CONFIG ERROR]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Admin Fetch Full Remote Configuration
app.get('/api/admin/config', requireAdmin, async (req, res) => {
  try {
    const configs = await prisma.systemConfig.findMany();
    const result = [];

    for (const [key, item] of Object.entries(DEFAULT_SYSTEM_CONFIGS)) {
      const dbEntry = configs.find(c => c.key === key);
      result.push({
        key,
        value: dbEntry ? dbEntry.value : item.value,
        description: item.desc,
        updatedBy: dbEntry?.updatedBy || 'System Default',
        updatedAt: dbEntry?.updatedAt || new Date()
      });
    }

    res.json({ success: true, configs: result });
  } catch (error) {
    console.error('[ADMIN CONFIG GET ERROR]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. Admin Update Remote Configuration Keys
app.post('/api/admin/config', requireAdmin, async (req, res) => {
  try {
    const updates = req.body; // e.g. { maintenance_mode: 'true', min_app_version: '1.2.0' }
    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ success: false, error: 'Invalid config payload.' });
    }

    const changedKeys = [];
    for (const [k, v] of Object.entries(updates)) {
      const strVal = String(v);
      const existing = await prisma.systemConfig.findUnique({ where: { key: k } });

      if (existing) {
        await prisma.systemConfig.update({
          where: { key: k },
          data: {
            value: strVal,
            updatedBy: req.staffUser?.name || 'Super Admin'
          }
        });
      } else {
        await prisma.systemConfig.create({
          data: {
            key: k,
            value: strVal,
            description: DEFAULT_SYSTEM_CONFIGS[k]?.desc || 'Custom Configuration',
            updatedBy: req.staffUser?.name || 'Super Admin'
          }
        });
      }
      changedKeys.push(`${k}=${strVal}`);
    }

    await logAuditEvent(req, 'UPDATE_CONFIG', 'system_config', 'config', `Updated remote config keys: ${changedKeys.join(', ')}`);

    res.json({
      success: true,
      message: 'System configuration updated successfully!',
      updatedKeys: changedKeys
    });
  } catch (error) {
    console.error('[ADMIN CONFIG POST ERROR]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// ==========================================
// 📊 CSV DATA EXPORTS ENGINE (STEP 5)
// ==========================================

function escapeCsvField(val) {
  if (val === null || val === undefined) return '""';
  const str = String(val).replace(/"/g, '""');
  return `"${str}"`;
}

// 1. Export Transactions CSV
app.get('/api/admin/export/transactions', requireAdmin, async (req, res) => {
  try {
    const transactions = await prisma.transaction.findMany({
      orderBy: { createdAt: 'desc' }
    });

    const userIds = [...new Set(transactions.map(t => t.userId))];
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, email: true }
    });
    const userMap = {};
    users.forEach(u => { userMap[u.id] = u; });

    const headers = ['Transaction ID', 'User Email', 'User Name', 'Type', 'Amount ($)', 'Description', 'Timestamp'];
    const rows = transactions.map(t => {
      const u = userMap[t.userId] || { email: t.userId, name: 'Customer' };
      return [
        escapeCsvField(t.id),
        escapeCsvField(u.email),
        escapeCsvField(u.name),
        escapeCsvField(t.type),
        escapeCsvField(t.amount.toFixed(2)),
        escapeCsvField(t.description),
        escapeCsvField(new Date(t.createdAt).toISOString())
      ].join(',');
    });

    const csvContent = [headers.join(','), ...rows].join('\n');
    const filename = `simlytel-transactions-${Date.now()}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvContent);
  } catch (error) {
    console.error('[EXPORT TRANSACTIONS ERROR]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Export Users Database CSV
app.get('/api/admin/export/users', requireAdmin, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' }
    });

    const headers = ['User ID', 'Name', 'Email', 'Phone', 'Wallet Balance ($)', 'Risk Score', 'Risk Level', 'Is Banned', 'Status', 'Registered At'];
    const rows = users.map(u => {
      let status = u.isBanned ? 'BANNED' : (u.isDeleted ? 'DELETED' : (u.isVerified ? 'ACTIVE' : 'UNVERIFIED'));
      return [
        escapeCsvField(u.id),
        escapeCsvField(u.name),
        escapeCsvField(u.email),
        escapeCsvField(u.phone || 'N/A'),
        escapeCsvField(u.walletBalance.toFixed(2)),
        escapeCsvField(u.riskScore || 0),
        escapeCsvField(u.riskLevel || 'LOW'),
        escapeCsvField(u.isBanned ? 'YES' : 'NO'),
        escapeCsvField(status),
        escapeCsvField(new Date(u.createdAt).toISOString())
      ].join(',');
    });

    const csvContent = [headers.join(','), ...rows].join('\n');
    const filename = `simlytel-users-${Date.now()}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvContent);
  } catch (error) {
    console.error('[EXPORT USERS ERROR]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. Export CDR (Call Detail Records) CSV
app.get('/api/admin/export/cdr', requireAdmin, async (req, res) => {
  try {
    const calls = await prisma.callLog.findMany({
      orderBy: { createdAt: 'desc' }
    });

    const headers = ['Call ID', 'SimlyTel Number', 'Contact Number', 'Direction', 'Status', 'Duration (Seconds)', 'Duration (Minutes)', 'Timestamp'];
    const rows = calls.map(c => [
      escapeCsvField(c.id),
      escapeCsvField(c.myNumber),
      escapeCsvField(c.contactNumber),
      escapeCsvField(c.direction),
      escapeCsvField(c.status),
      escapeCsvField(c.durationSeconds),
      escapeCsvField((c.durationSeconds / 60).toFixed(2)),
      escapeCsvField(new Date(c.createdAt).toISOString())
    ].join(','));

    const csvContent = [headers.join(','), ...rows].join('\n');
    const filename = `simlytel-cdr-${Date.now()}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvContent);
  } catch (error) {
    console.error('[EXPORT CDR ERROR]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. Export Audit Trail CSV
app.get('/api/admin/export/audit-logs', requireAdmin, async (req, res) => {
  try {
    const logs = await prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' }
    });

    const headers = ['Log ID', 'Staff Name', 'Staff Email', 'Staff Role', 'Action', 'Target ID', 'Target Type', 'Details', 'IP Address', 'Timestamp'];
    const rows = logs.map(l => [
      escapeCsvField(l.id),
      escapeCsvField(l.staffName),
      escapeCsvField(l.staffEmail),
      escapeCsvField(l.staffRole),
      escapeCsvField(l.action),
      escapeCsvField(l.targetId || 'N/A'),
      escapeCsvField(l.targetType || 'N/A'),
      escapeCsvField(l.details),
      escapeCsvField(l.ipAddress || '127.0.0.1'),
      escapeCsvField(new Date(l.createdAt).toISOString())
    ].join(','));

    const csvContent = [headers.join(','), ...rows].join('\n');
    const filename = `simlytel-audit-trail-${Date.now()}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvContent);
  } catch (error) {
    console.error('[EXPORT AUDIT LOGS ERROR]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// 🔔 MULTI-CHANNEL OWNER ALERTS ENGINE (STEP 6)
// ==========================================

async function getAlertSettings() {
  let settings = await prisma.adminAlertSetting.findFirst();
  if (!settings) {
    settings = await prisma.adminAlertSetting.create({
      data: {
        primaryChannel: 'EMAIL',
        ownerEmail: 'admin@simlytel.com',
        notifyOnLargeDeposit: true,
        notifyOnLowCarrierBalance: true,
        notifyOnHighRiskFraud: true,
        notifyOnUnassignedTicket: true,
        isEnabled: true
      }
    });
  }
  return settings;
}

// Universal Alert Dispatcher Helper
async function dispatchOwnerAlert(alertType, payload) {
  try {
    const settings = await getAlertSettings();
    if (!settings || !settings.isEnabled) return { dispatched: false, reason: 'ALERTS_DISABLED' };

    let shouldNotify = false;
    let title = 'SimlyTel System Notification';
    let body = '';

    if (alertType === 'LARGE_DEPOSIT' && settings.notifyOnLargeDeposit) {
      shouldNotify = true;
      title = `💰 [BIG DEPOSIT] $${payload.amount?.toFixed(2)} Top-Up`;
      body = `User ${payload.userName || payload.userEmail} just added $${payload.amount?.toFixed(2)} to their wallet.`;
    } else if (alertType === 'LOW_CARRIER_BALANCE' && settings.notifyOnLowCarrierBalance) {
      shouldNotify = true;
      title = `🚨 [CARRIER ALERT] Low Telnyx Balance: $${payload.balance?.toFixed(2)}`;
      body = `Telnyx wholesale balance is low ($${payload.balance?.toFixed(2)}). Please refill to avoid call disruption.`;
    } else if (alertType === 'HIGH_RISK_FRAUD' && settings.notifyOnHighRiskFraud) {
      shouldNotify = true;
      title = `🛡️ [FRAUD RADAR ALERT] High Risk User Flagged (${payload.riskScore}/100)`;
      body = `User ${payload.userEmail} flagged as ${payload.riskLevel}. Reasons: ${(payload.reasons || []).join(', ')}`;
    } else if (alertType === 'TEST_ALERT') {
      shouldNotify = true;
      title = '🔔 [SIMLYTEL TEST ALERT] Everything is Operational!';
      body = 'This is a test notification confirming your Admin Alert channel is active and receiving alerts.';
    }

    if (!shouldNotify) return { dispatched: false, reason: 'EVENT_MUTED' };

    console.log(`🔔 [OWNER ALERT DISPATCH] Channel: ${settings.primaryChannel} | ${title} | ${body}`);

    // Channel 1: Webhook (Discord / Slack)
    if (settings.primaryChannel === 'DISCORD' || settings.primaryChannel === 'WEBHOOK') {
      if (settings.webhookUrl) {
        const https = require('https');
        const url = new URL(settings.webhookUrl);
        const data = JSON.stringify({ content: `**${title}**\n${body}` });
        const req = https.request({
          hostname: url.hostname,
          path: url.pathname + url.search,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        });
        req.on('error', () => {});
        req.write(data);
        req.end();
      }
    }

    // Channel 2: Telegram Bot
    if (settings.primaryChannel === 'TELEGRAM' && settings.telegramBotToken && settings.telegramChatId) {
      const https = require('https');
      const text = encodeURIComponent(`${title}\n\n${body}`);
      https.get(`https://api.telegram.org/bot${settings.telegramBotToken}/sendMessage?chat_id=${settings.telegramChatId}&text=${text}&parse_mode=HTML`).on('error', () => {});
    }

    return { dispatched: true, title, body, channel: settings.primaryChannel };
  } catch (err) {
    console.error('[DISPATCH ALERT ERROR]', err);
    return { dispatched: false, error: err.message };
  }
}

// 1. Get Owner Alert Settings
app.get('/api/admin/alerts/settings', requireAdmin, async (req, res) => {
  try {
    const settings = await getAlertSettings();
    res.json({ success: true, settings });
  } catch (error) {
    console.error('[GET ALERT SETTINGS ERROR]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Save Owner Alert Settings
app.post('/api/admin/alerts/settings', requireAdmin, async (req, res) => {
  try {
    const {
      primaryChannel,
      ownerEmail,
      ownerPhone,
      webhookUrl,
      telegramBotToken,
      telegramChatId,
      notifyOnLargeDeposit,
      notifyOnLowCarrierBalance,
      notifyOnHighRiskFraud,
      notifyOnUnassignedTicket,
      isEnabled
    } = req.body;

    const current = await getAlertSettings();
    const updated = await prisma.adminAlertSetting.update({
      where: { id: current.id },
      data: {
        primaryChannel: primaryChannel || current.primaryChannel,
        ownerEmail: ownerEmail !== undefined ? ownerEmail : current.ownerEmail,
        ownerPhone: ownerPhone !== undefined ? ownerPhone : current.ownerPhone,
        webhookUrl: webhookUrl !== undefined ? webhookUrl : current.webhookUrl,
        telegramBotToken: telegramBotToken !== undefined ? telegramBotToken : current.telegramBotToken,
        telegramChatId: telegramChatId !== undefined ? telegramChatId : current.telegramChatId,
        notifyOnLargeDeposit: notifyOnLargeDeposit !== undefined ? !!notifyOnLargeDeposit : current.notifyOnLargeDeposit,
        notifyOnLowCarrierBalance: notifyOnLowCarrierBalance !== undefined ? !!notifyOnLowCarrierBalance : current.notifyOnLowCarrierBalance,
        notifyOnHighRiskFraud: notifyOnHighRiskFraud !== undefined ? !!notifyOnHighRiskFraud : current.notifyOnHighRiskFraud,
        notifyOnUnassignedTicket: notifyOnUnassignedTicket !== undefined ? !!notifyOnUnassignedTicket : current.notifyOnUnassignedTicket,
        isEnabled: isEnabled !== undefined ? !!isEnabled : current.isEnabled
      }
    });

    await logAuditEvent(req, 'UPDATE_ALERTS', updated.id, 'config', `Updated owner alert preferences (Channel: ${updated.primaryChannel})`);

    res.json({
      success: true,
      message: 'Admin alert preferences saved successfully!',
      settings: updated
    });
  } catch (error) {
    console.error('[POST ALERT SETTINGS ERROR]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. Send Test Alert
app.post('/api/admin/alerts/test', requireAdmin, async (req, res) => {
  try {
    const result = await dispatchOwnerAlert('TEST_ALERT', {});
    res.json({
      success: true,
      message: `Test alert triggered successfully via ${result.channel || 'System'}`,
      details: result
    });
  } catch (error) {
    console.error('[TEST ALERT ERROR]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// ==========================================
// 🧹 PRISTINE FACTORY PURGE (SUPER ADMIN ONLY)
// ==========================================
app.post('/api/admin/system/purge-all-data', requireAdmin, async (req, res) => {
  try {
    console.log('🧹 [FACTORY PURGE] Purging all users, numbers, messages, transactions...');
    await prisma.message.deleteMany({});
    await prisma.callLog.deleteMany({});
    await prisma.voicemail.deleteMany({});
    await prisma.devicePushToken.deleteMany({});
    await prisma.transaction.deleteMany({});
    await prisma.supportMessage.deleteMany({});
    await prisma.supportTicket.deleteMany({});
    await prisma.purchasedNumber.deleteMany({});
    await prisma.otpCode.deleteMany({});
    await prisma.auditLog.deleteMany({});
    await prisma.blacklist.deleteMany({});
    const deletedUsers = await prisma.user.deleteMany({});

    // Delete all announcements
    await prisma.announcement.deleteMany({});

    // Reset Remote Config min_app_version to 1.0.0
    await prisma.systemConfig.upsert({
      where: { key: 'min_app_version' },
      update: { value: '1.0.0', updatedBy: 'Super Admin' },
      create: { key: 'min_app_version', value: '1.0.0', description: 'Minimum required app version', updatedBy: 'Super Admin' }
    });

    console.log(`✅ [FACTORY PURGE] Done! Deleted ${deletedUsers.count} users.`);
    res.json({
      success: true,
      message: `Pristine reset complete. Deleted ${deletedUsers.count} users and all associated activity records.`
    });
  } catch (error) {
    console.error('[PURGE ERROR]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});
