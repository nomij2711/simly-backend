const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Helper to normalize phone numbers
const normalizePhone = (num) => (num ? num.toString().trim().replace(/^ /, '+') : num);

// Memory stores for testing
const inboundFloodWindowMap = new Map();
const inboundCooldownMap = new Map();

const DEFAULT_SYSTEM_CONFIGS = {
  fup_shield_enabled: { value: 'true' },
  fup_burst_limit_count: { value: '10' },
  fup_burst_window_seconds: { value: '60' },
  fup_cooldown_duration_minutes: { value: '120' },
  fup_voice_margin_threshold: { value: '10' },
  fup_sms_margin_threshold: { value: '1' },
  fup_overage_charge_enabled: { value: 'false' },
  fup_overage_sms_price: { value: '0.0050' }
};

async function getSystemConfigsMap() {
  const configs = await prisma.systemConfig.findMany();
  const configMap = {};
  for (const [key, item] of Object.entries(DEFAULT_SYSTEM_CONFIGS)) {
    configMap[key] = item.value;
  }
  for (const c of configs) {
    configMap[c.key] = c.value;
  }
  return configMap;
}

// Engine Gate Evaluator
async function evaluateInboundShieldGate(rawPhoneNumber, eventType = 'sms', carrier = 'TELNYX') {
  try {
    const cleanPhone = normalizePhone(rawPhoneNumber);
    if (!cleanPhone) {
      return { allowed: true, reason: 'NO_PHONE_SPECIFIED' };
    }

    const configMap = await getSystemConfigsMap();
    const isShieldEnabled = configMap.fup_shield_enabled !== 'false';
    if (!isShieldEnabled) {
      return { allowed: true, reason: 'SHIELD_DISABLED' };
    }

    const now = Date.now();

    // 1. Check Active Flood Cooldown
    const activeCooldown = inboundCooldownMap.get(cleanPhone);
    if (activeCooldown) {
      if (now < activeCooldown.cooldownUntil) {
        const remainingSec = Math.ceil((activeCooldown.cooldownUntil - now) / 1000);
        return {
          allowed: false,
          reason: 'FLOOD_COOLDOWN',
          cooldownActive: true,
          cooldownUntil: activeCooldown.cooldownUntil,
          cooldownRemainingSec: remainingSec,
          cooldownRemainingMinutes: Math.ceil(remainingSec / 60),
          action: 'REJECT'
        };
      } else {
        inboundCooldownMap.delete(cleanPhone);
      }
    }

    // 2. Flood Burst Detection (Sliding Window)
    const burstWindowSec = parseInt(configMap.fup_burst_window_seconds || '60', 10);
    const burstLimitCount = parseInt(configMap.fup_burst_limit_count || '10', 10);
    const cooldownMins = parseInt(configMap.fup_cooldown_duration_minutes || '120', 10);

    const windowMs = burstWindowSec * 1000;
    let recentEvents = inboundFloodWindowMap.get(cleanPhone) || [];
    recentEvents = recentEvents.filter(t => now - t <= windowMs);
    recentEvents.push(now);
    inboundFloodWindowMap.set(cleanPhone, recentEvents);

    if (recentEvents.length > burstLimitCount) {
      const cooldownUntil = now + (cooldownMins * 60 * 1000);
      inboundCooldownMap.set(cleanPhone, {
        cooldownUntil,
        reason: `Exceeded ${burstLimitCount} inbound events in ${burstWindowSec}s`,
        triggeredAt: now
      });
      inboundFloodWindowMap.delete(cleanPhone);

      return {
        allowed: false,
        reason: 'FLOOD_COOLDOWN_TRIGGERED',
        cooldownActive: true,
        cooldownUntil,
        cooldownRemainingMinutes: cooldownMins,
        action: 'REJECT'
      };
    }

    // 3. Find Line Owner User
    const lineOwner = await prisma.purchasedNumber.findFirst({
      where: { phoneNumber: cleanPhone, status: 'active' }
    });

    if (!lineOwner || !lineOwner.userId) {
      return { allowed: false, reason: 'UNASSIGNED_OR_INACTIVE_LINE', action: 'REJECT' };
    }

    const ownerUser = await prisma.user.findFirst({
      where: { OR: [{ id: lineOwner.userId }, { email: lineOwner.userId }] }
    });

    if (!ownerUser) {
      return { allowed: false, reason: 'OWNER_USER_NOT_FOUND', action: 'REJECT' };
    }

    // 4. Calculate PnL for user
    const numbers = await prisma.purchasedNumber.findMany({ where: { userId: ownerUser.id } });
    const userPhoneNumbers = numbers.map(n => n.phoneNumber);
    const transactions = await prisma.transaction.findMany({ where: { userId: ownerUser.id } });
    const calls = await prisma.callLog.findMany({
      where: { OR: [{ myNumber: { in: userPhoneNumbers } }, { contactNumber: { in: userPhoneNumbers } }] }
    });
    const messages = await prisma.message.findMany({
      where: { OR: [{ fromNumber: { in: userPhoneNumbers } }, { toNumber: { in: userPhoneNumbers } }] }
    });

    let retailRev = 0;
    let wholesaleCost = 0;

    transactions.filter(t => t.type.includes('number_purchase') || t.type.includes('renewal')).forEach(t => {
      retailRev += Math.abs(t.amount);
      wholesaleCost += 1.00; // standard US wholesale line cost
    });

    // Inbound wholesale
    const inSms = messages.filter(m => m.direction === 'inbound');
    inSms.forEach(m => {
      wholesaleCost += (carrier === 'TWILIO' ? 0.0075 : 0.0020);
    });

    const inCalls = calls.filter(c => c.direction === 'inbound');
    inCalls.forEach(c => {
      const mins = Math.ceil((c.durationSeconds || 0) / 60);
      wholesaleCost += mins * (carrier === 'TWILIO' ? 0.0100 : 0.0050);
    });

    const netProfit = retailRev - wholesaleCost;
    const marginPercent = retailRev > 0 ? (netProfit / retailRev) * 100 : (wholesaleCost > 0 ? -100 : 0);

    const voiceMarginThreshold = parseFloat(configMap.fup_voice_margin_threshold || '10');
    const smsMarginThreshold = parseFloat(configMap.fup_sms_margin_threshold || '1');

    // Rule A: Voice Gate (<= 10% Margin)
    if (eventType === 'voice' || eventType === 'call') {
      if (marginPercent <= voiceMarginThreshold) {
        return {
          allowed: false,
          reason: 'LOW_MARGIN_VOICE_LOCK',
          marginPercent,
          threshold: voiceMarginThreshold,
          action: 'REJECT',
          ownerUser,
          lineOwner
        };
      }
    }

    // Rule B: SMS Gate (<= 1% Margin)
    if (eventType === 'sms') {
      if (marginPercent <= smsMarginThreshold) {
        return {
          allowed: false,
          reason: 'LOW_MARGIN_SMS_LOCK',
          marginPercent,
          threshold: smsMarginThreshold,
          action: 'PAUSE_SMS',
          ownerUser,
          lineOwner
        };
      }
    }

    return {
      allowed: true,
      reason: 'ALLOWED',
      marginPercent,
      ownerUser,
      lineOwner
    };
  } catch (err) {
    return { allowed: true, reason: 'GATE_ERROR_FALLBACK', error: err.message };
  }
}

async function runDeepVerification() {
  console.log('================================================================');
  console.log('🔬 AUTONOMOUS TELECOM MARGIN & INBOUND SHIELD (FUP) AUDIT');
  console.log('================================================================\n');

  let passCount = 0;
  let failCount = 0;

  function assertTrue(cond, label) {
    if (cond) {
      console.log(`  ✅ [PASS] ${label}`);
      passCount++;
    } else {
      console.error(`  ❌ [FAIL] ${label}`);
      failCount++;
    }
  }

  function assertEqual(actual, expected, label) {
    if (actual === expected) {
      console.log(`  ✅ [PASS] ${label}: ${actual}`);
      passCount++;
    } else {
      console.error(`  ❌ [FAIL] ${label}: Got ${actual}, Expected ${expected}`);
      failCount++;
    }
  }

  try {
    // PASS 1: Seed Clean Test Matrix
    console.log('--- PASS 1: SETUP TEST ACCOUNTS & TELECOM SCENARIOS ---');

    // User A: Ali (Profitable ~69% Margin)
    const userAli = await prisma.user.upsert({
      where: { email: 'fup_ali@simlyx.test' },
      update: { walletBalance: 25.0 },
      create: { id: 'fup_u1_ali', name: 'Ali (Profitable)', email: 'fup_ali@simlyx.test', walletBalance: 25.0 }
    });

    const numAli = await prisma.purchasedNumber.upsert({
      where: { id: 'num_fup_ali' },
      update: { status: 'active' },
      create: { id: 'num_fup_ali', phoneNumber: '+12025550101', userId: userAli.id, countryCode: 'US', carrier: 'TELNYX', planType: '30_days', status: 'active' }
    });

    await prisma.transaction.deleteMany({ where: { userId: userAli.id } });
    await prisma.callLog.deleteMany({ where: { myNumber: numAli.phoneNumber } });
    await prisma.message.deleteMany({ where: { toNumber: numAli.phoneNumber } });

    await prisma.transaction.create({
      data: { userId: userAli.id, type: 'number_purchase', amount: -3.25, description: 'Line Purchase: +12025550101' }
    });

    // User B: Bilal (Low Margin ~9% Margin, below 10% Voice Threshold)
    const userBilal = await prisma.user.upsert({
      where: { email: 'fup_bilal@simlyx.test' },
      update: { walletBalance: 15.0 },
      create: { id: 'fup_u2_bilal', name: 'Bilal (Low Margin)', email: 'fup_bilal@simlyx.test', walletBalance: 15.0 }
    });

    const numBilal = await prisma.purchasedNumber.upsert({
      where: { id: 'num_fup_bilal' },
      update: { status: 'active' },
      create: { id: 'num_fup_bilal', phoneNumber: '+12025550102', userId: userBilal.id, countryCode: 'US', carrier: 'TELNYX', planType: '30_days', status: 'active' }
    });

    await prisma.transaction.deleteMany({ where: { userId: userBilal.id } });
    await prisma.callLog.deleteMany({ where: { myNumber: numBilal.phoneNumber } });
    await prisma.message.deleteMany({ where: { toNumber: numBilal.phoneNumber } });

    await prisma.transaction.create({
      data: { userId: userBilal.id, type: 'number_purchase', amount: -1.10, description: 'Line Purchase: +12025550102' }
    });

    // User C: Kamran (Loss Maker -37.5%, below 1% SMS Threshold)
    const userKamran = await prisma.user.upsert({
      where: { email: 'fup_kamran@simlyx.test' },
      update: { walletBalance: 10.0 },
      create: { id: 'fup_u3_kamran', name: 'Kamran (Loss Maker)', email: 'fup_kamran@simlyx.test', walletBalance: 10.0 }
    });

    const numKamran = await prisma.purchasedNumber.upsert({
      where: { id: 'num_fup_kamran' },
      update: { status: 'active' },
      create: { id: 'num_fup_kamran', phoneNumber: '+12025550103', userId: userKamran.id, countryCode: 'US', carrier: 'TWILIO', planType: '30_days', status: 'active' }
    });

    await prisma.transaction.deleteMany({ where: { userId: userKamran.id } });
    await prisma.callLog.deleteMany({ where: { myNumber: numKamran.phoneNumber } });
    await prisma.message.deleteMany({ where: { toNumber: numKamran.phoneNumber } });

    await prisma.transaction.create({
      data: { userId: userKamran.id, type: 'number_purchase', amount: -1.00, description: 'Line Purchase: +12025550103' }
    });

    // 50 inbound SMS on Twilio = $0.375 wholesale cost + $1.00 line = $1.375 total cost vs $1.00 rev = -37.5% margin
    for (let i = 0; i < 50; i++) {
      await prisma.message.create({
        data: {
          fromNumber: '+18005559999',
          toNumber: numKamran.phoneNumber,
          text: `Inbound OTP test #${i}`,
          direction: 'inbound',
          status: 'received'
        }
      });
    }

    console.log('✅ 3 Profiles & Scenarios Successfully Created.\n');

    // PASS 2: MARGIN GATE BEHAVIOR VERIFICATION
    console.log('--- PASS 2: VERIFYING 2-STAGE MARGIN GATE RULES ---');

    // 1. Ali (Profitable: ~69%)
    const gateAliVoice = await evaluateInboundShieldGate(numAli.phoneNumber, 'voice', 'TELNYX');
    assertEqual(gateAliVoice.allowed, true, 'User Ali Voice Allowed (> 10% Margin)');
    assertEqual(gateAliVoice.reason, 'ALLOWED', 'User Ali Voice Reason');

    const gateAliSms = await evaluateInboundShieldGate(numAli.phoneNumber, 'sms', 'TELNYX');
    assertEqual(gateAliSms.allowed, true, 'User Ali SMS Allowed (> 1% Margin)');
    assertEqual(gateAliSms.reason, 'ALLOWED', 'User Ali SMS Reason');

    // 2. Bilal (Low Margin: 9.09% <= 10%)
    const gateBilalVoice = await evaluateInboundShieldGate(numBilal.phoneNumber, 'voice', 'TELNYX');
    assertEqual(gateBilalVoice.allowed, false, 'User Bilal Voice Blocked (<= 10% Margin)');
    assertEqual(gateBilalVoice.reason, 'LOW_MARGIN_VOICE_LOCK', 'User Bilal Voice Lock Reason');
    assertEqual(gateBilalVoice.action, 'REJECT', 'User Bilal Voice Action (<Reject/> $0 Cost)');

    const gateBilalSms = await evaluateInboundShieldGate(numBilal.phoneNumber, 'sms', 'TELNYX');
    assertEqual(gateBilalSms.allowed, true, 'User Bilal SMS Allowed (> 1% Margin)');
    assertEqual(gateBilalSms.reason, 'ALLOWED', 'User Bilal SMS Reason');

    // 3. Kamran (Loss Maker: -37.5% <= 1%)
    const gateKamranVoice = await evaluateInboundShieldGate(numKamran.phoneNumber, 'voice', 'TWILIO');
    assertEqual(gateKamranVoice.allowed, false, 'User Kamran Voice Blocked (<= 10% Margin)');
    assertEqual(gateKamranVoice.reason, 'LOW_MARGIN_VOICE_LOCK', 'User Kamran Voice Reason');

    const gateKamranSms = await evaluateInboundShieldGate(numKamran.phoneNumber, 'sms', 'TWILIO');
    assertEqual(gateKamranSms.allowed, false, 'User Kamran SMS Paused (<= 1% Margin)');
    assertEqual(gateKamranSms.reason, 'LOW_MARGIN_SMS_LOCK', 'User Kamran SMS Reason');
    assertEqual(gateKamranSms.action, 'PAUSE_SMS', 'User Kamran SMS Action');

    console.log('\n--- PASS 3: ANTI-FLOOD BURST & COOLDOWN TEST ---');
    const floodTestNumber = '+12025550999';
    inboundFloodWindowMap.delete(floodTestNumber);
    inboundCooldownMap.delete(floodTestNumber);

    // Send 10 burst events in 60s
    for (let i = 1; i <= 10; i++) {
      const res = await evaluateInboundShieldGate(floodTestNumber, 'sms', 'TELNYX');
      assertTrue(res.reason !== 'FLOOD_COOLDOWN_TRIGGERED', `Burst event #${i} processed without triggering cooldown`);
    }

    // 11th event in 60s MUST trigger 2-hour cooldown
    const event11 = await evaluateInboundShieldGate(floodTestNumber, 'sms', 'TELNYX');
    assertEqual(event11.allowed, false, '11th Burst Event Disallowed');
    assertEqual(event11.reason, 'FLOOD_COOLDOWN_TRIGGERED', '11th Burst Event Triggered Cooldown');
    assertEqual(event11.cooldownRemainingMinutes, 120, '2-Hour (120 min) Cooldown Applied');

    // Immediate next attempt during cooldown
    const cooldownNext = await evaluateInboundShieldGate(floodTestNumber, 'voice', 'TELNYX');
    assertEqual(cooldownNext.allowed, false, 'Subsequent Inbound Voice Rejected in Cooldown');
    assertEqual(cooldownNext.reason, 'FLOOD_COOLDOWN', 'Cooldown Active Reason');

    // Reset cooldown
    inboundCooldownMap.delete(floodTestNumber);
    inboundFloodWindowMap.delete(floodTestNumber);
    const afterReset = await evaluateInboundShieldGate(floodTestNumber, 'sms', 'TELNYX');
    assertTrue(afterReset.reason !== 'FLOOD_COOLDOWN', 'Cooldown Successfully Cleared on Reset');

    console.log('\n--- PASS 4: AUTO-RECOVERY UPON NUMBER RENEWAL TEST ---');
    // Kamran renews his number ($3.00 renewal revenue added)
    await prisma.transaction.create({
      data: {
        userId: userKamran.id,
        type: 'renewal',
        amount: -3.00,
        description: 'Line Renewal: +12025550103'
      }
    });

    // Now Total Revenue = $4.00, Wholesale Cost = $2.375 -> Net Profit = +$1.625 (40.6% Margin)
    const gateKamranVoiceAfterRenew = await evaluateInboundShieldGate(numKamran.phoneNumber, 'voice', 'TWILIO');
    assertEqual(gateKamranVoiceAfterRenew.allowed, true, 'User Kamran Voice Auto-Unlocked After Renewal (Margin: 40.6% > 10%)');

    const gateKamranSmsAfterRenew = await evaluateInboundShieldGate(numKamran.phoneNumber, 'sms', 'TWILIO');
    assertEqual(gateKamranSmsAfterRenew.allowed, true, 'User Kamran SMS Auto-Unlocked After Renewal (Margin: 40.6% > 1%)');

    console.log('\n================================================================');
    console.log(`📊 FINAL RESULTS: ${passCount} PASSED, ${failCount} FAILED`);
    console.log('================================================================\n');

    if (failCount === 0) {
      console.log('🏆 100% OF FUP SHIELD TESTS PASSED WITH ZERO ERRORS!');
    }
  } catch (err) {
    console.error('❌ Audit encountered an exception:', err);
  } finally {
    await prisma.$disconnect();
  }
}

runDeepVerification();
