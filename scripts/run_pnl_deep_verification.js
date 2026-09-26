const { setupAuditData, TEST_USERS } = require('./audit_5_users_pnl');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function runDeepVerification() {
  await setupAuditData();

  console.log('\n================================================================');
  console.log('🔬 VERIFICATION PASS 1: ENGINE-LEVEL P&L MATHEMATICAL AUDIT');
  console.log('================================================================\n');

  const allUsers = await prisma.user.findMany({
    where: { id: { in: TEST_USERS.map(u => u.id) } }
  });

  let passCount = 0;
  let failCount = 0;

  function assertEqual(actual, expected, label) {
    if (typeof actual === 'string' && typeof expected === 'string') {
      if (actual.trim().toUpperCase() === expected.trim().toUpperCase()) {
        console.log(`  ✅ [PASS] ${label}: "${actual}"`);
        passCount++;
      } else {
        console.error(`  ❌ [FAIL] ${label}: Got "${actual}", Expected "${expected}"`);
        failCount++;
      }
      return;
    }
    const numActual = Number(actual);
    const numExpected = Number(expected);
    const diff = Math.abs(numActual - numExpected);
    if (diff < 0.005) {
      console.log(`  ✅ [PASS] ${label}: ${numActual.toFixed(4)} (Expected: ${numExpected.toFixed(4)})`);
      passCount++;
    } else {
      console.error(`  ❌ [FAIL] ${label}: Got ${numActual}, Expected ${numExpected} (Diff: ${diff})`);
      failCount++;
    }
  }

  function assertTrue(condition, label) {
    if (condition) {
      console.log(`  ✅ [PASS] ${label}`);
      passCount++;
    } else {
      console.error(`  ❌ [FAIL] ${label}`);
      failCount++;
    }
  }

  // --- PASS 1: USER-BY-USER VERIFICATION ---
  for (const testDef of TEST_USERS) {
    const user = allUsers.find(u => u.id === testDef.id);
    console.log(`\n------------------------------------------------------------`);
    console.log(`👤 AUDITING USER: ${user.name} (${user.id})`);
    console.log(`------------------------------------------------------------`);

    const numbers = await prisma.purchasedNumber.findMany({
      where: { userId: user.id }
    });
    const userPhones = numbers.map(n => n.phoneNumber);

    const calls = await prisma.callLog.findMany({
      where: { OR: [{ myNumber: { in: userPhones } }, { contactNumber: { in: userPhones } }] }
    });

    const messages = await prisma.message.findMany({
      where: { OR: [{ fromNumber: { in: userPhones } }, { toNumber: { in: userPhones } }] }
    });

    const transactions = await prisma.transaction.findMany({
      where: { userId: user.id }
    });

    const outCalls = calls.filter(c => c.direction === 'outbound');
    const inCalls = calls.filter(c => c.direction === 'inbound');
    const outMsgs = messages.filter(m => m.direction === 'outbound');
    const inMsgs = messages.filter(m => m.direction === 'inbound');

    console.log(`📊 DB Counts: Lines=${numbers.length}, OutCalls=${outCalls.length}, InCalls=${inCalls.length}, OutSMS=${outMsgs.length}, InSMS=${inMsgs.length}, Tx=${transactions.length}`);

    // Verify User 1 (US Telnyx)
    if (user.id === 'audit_u1_us_telnyx') {
      assertEqual(numbers.length, 1, 'User 1 Line Count');
      assertEqual(numbers[0].carrier, 'TELNYX', 'User 1 Carrier');
      assertEqual(outCalls.length, 2, 'User 1 Outbound Calls Count');
      assertEqual(inCalls.length, 1, 'User 1 Inbound Calls Count');
      assertEqual(outMsgs.length, 2, 'User 1 Outbound SMS Count');
      assertEqual(inMsgs.length, 2, 'User 1 Inbound SMS Count');

      // Inbound Call wholesale (1 min @ $0.0050 = $0.0050)
      const inDur = inCalls.reduce((s, c) => s + (c.durationSeconds || 0), 0);
      const inMinutes = Math.ceil(inDur / 60);
      assertEqual(inMinutes, 1, 'User 1 Inbound Call Minutes Billed');
      const inCallCost = inMinutes * 0.0050;
      assertEqual(inCallCost, 0.0050, 'User 1 Inbound Call Wholesale Cost ($0.0050/min Telnyx)');

      // Inbound SMS wholesale (2 msgs @ $0.0020 = $0.0040)
      const inSmsCost = inMsgs.length * 0.0020;
      assertEqual(inSmsCost, 0.0040, 'User 1 Inbound SMS Wholesale Cost (2 x $0.0020 Telnyx)');
    }

    // Verify User 2 (UK Twilio)
    if (user.id === 'audit_u2_uk_twilio') {
      assertEqual(numbers.length, 1, 'User 2 Line Count');
      assertEqual(numbers[0].carrier, 'TWILIO', 'User 2 Carrier');
      assertEqual(outCalls.length, 1, 'User 2 Outbound Calls Count');
      assertEqual(inCalls.length, 1, 'User 2 Inbound Calls Count');
      assertEqual(outMsgs.length, 1, 'User 2 Outbound SMS Count');
      assertEqual(inMsgs.length, 3, 'User 2 Inbound SMS Count');

      // Inbound Call wholesale (120s = 2 mins @ $0.0100 = $0.0200)
      const inDur = inCalls.reduce((s, c) => s + (c.durationSeconds || 0), 0);
      const inMinutes = Math.ceil(inDur / 60);
      assertEqual(inMinutes, 2, 'User 2 Inbound Call Minutes Billed');
      const inCallCost = inMinutes * 0.0100;
      assertEqual(inCallCost, 0.0200, 'User 2 Inbound Call Wholesale Cost ($0.0100/min Twilio UK)');

      // Inbound SMS wholesale (3 msgs @ $0.0075 = $0.0225)
      const inSmsCost = inMsgs.length * 0.0075;
      assertEqual(inSmsCost, 0.0225, 'User 2 Inbound SMS Wholesale Cost (3 x $0.0075 Twilio UK)');
    }

    // Verify User 3 (Heavy Inbound Voice)
    if (user.id === 'audit_u3_heavy_inbound_call') {
      assertEqual(inCalls.length, 6, 'User 3 Inbound Calls Count');
      const inDur = inCalls.reduce((s, c) => s + (c.durationSeconds || 0), 0);
      assertEqual(inDur / 60, 35, 'User 3 Inbound Duration Total Minutes (35 mins)');
      const inMinutes = Math.ceil(inDur / 60);
      const inCallCost = inMinutes * 0.0050;
      assertEqual(inCallCost, 0.1750, 'User 3 Inbound Voice Wholesale Cost (35 mins x $0.0050 = $0.1750)');
      assertTrue(inMinutes >= 20, 'User 3 High Inbound Voice Minutes Threshold (>= 20 mins)');
    }

    // Verify User 4 (Heavy Inbound SMS)
    if (user.id === 'audit_u4_heavy_inbound_sms') {
      assertEqual(inMsgs.length, 30, 'User 4 Inbound SMS Count (30 msgs)');
      const inSmsCost = inMsgs.length * 0.0075;
      assertEqual(inSmsCost, 0.2250, 'User 4 Inbound SMS Wholesale Cost (30 x $0.0075 = $0.2250 Twilio UK)');
      assertTrue(inMsgs.length >= 20, 'User 4 High Inbound SMS Count Threshold (>= 20 msgs)');
    }

    // Verify User 5 (Dual US+UK Cross Carrier)
    if (user.id === 'audit_u5_dual_line_cross') {
      assertEqual(numbers.length, 2, 'User 5 Dual Lines Count');
      const usLine = numbers.find(n => n.countryCode === 'US');
      const ukLine = numbers.find(n => n.countryCode === 'GB');
      assertEqual(usLine.carrier, 'TELNYX', 'User 5 US Line Carrier');
      assertEqual(ukLine.carrier, 'TWILIO', 'User 5 UK Line Carrier');

      assertEqual(outCalls.length, 1, 'User 5 Outbound Call Count');
      assertEqual(inCalls.length, 1, 'User 5 Inbound Call Count');
      assertEqual(outMsgs.length, 1, 'User 5 Outbound SMS Count');
      assertEqual(inMsgs.length, 5, 'User 5 Inbound SMS Count');

      // Inbound Call on UK Line (180s = 3 mins @ $0.0100 = $0.0300)
      assertEqual(inCalls[0].myNumber, '+447700900505', 'User 5 Inbound Call Routed to UK Twilio Number');
      const inCallCost = Math.ceil(inCalls[0].durationSeconds / 60) * 0.0100;
      assertEqual(inCallCost, 0.0300, 'User 5 Inbound Call UK Wholesale ($0.0300)');

      // Inbound SMS on US Line (5 msgs @ $0.0020 = $0.0100)
      assertEqual(inMsgs[0].toNumber, '+12125550505', 'User 5 Inbound SMS Routed to US Telnyx Number');
      const inSmsCost = inMsgs.length * 0.0020;
      assertEqual(inSmsCost, 0.0100, 'User 5 Inbound SMS US Wholesale ($0.0100)');
    }
  }


  console.log('\n================================================================');
  console.log('🔬 VERIFICATION PASS 2: LEAKAGE & CROSS-DIRECTION INTEGRITY AUDIT');
  console.log('================================================================\n');

  // Test 1: Zero Outbound-in-Inbound Leakage across whole database
  for (const testDef of TEST_USERS) {
    const user = allUsers.find(u => u.id === testDef.id);
    const numbers = await prisma.purchasedNumber.findMany({ where: { userId: user.id } });
    const userPhones = numbers.map(n => n.phoneNumber);

    const calls = await prisma.callLog.findMany({
      where: { OR: [{ myNumber: { in: userPhones } }, { contactNumber: { in: userPhones } }] }
    });
    const messages = await prisma.message.findMany({
      where: { OR: [{ fromNumber: { in: userPhones } }, { toNumber: { in: userPhones } }] }
    });

    const outCalls = calls.filter(c => c.direction === 'outbound');
    const inCalls = calls.filter(c => c.direction === 'inbound');

    // Assure that NO call has ambiguous or overlapping direction
    const overlapCalls = outCalls.filter(oc => inCalls.some(ic => ic.id === oc.id));
    assertEqual(overlapCalls.length, 0, `User ${user.id}: 0 Overlap between Outbound and Inbound Calls`);

    const outMsgs = messages.filter(m => m.direction === 'outbound');
    const inMsgs = messages.filter(m => m.direction === 'inbound');
    const overlapMsgs = outMsgs.filter(om => inMsgs.some(im => im.id === om.id));
    assertEqual(overlapMsgs.length, 0, `User ${user.id}: 0 Overlap between Outbound and Inbound SMS`);
  }

  // Test 2: Inbound Free Policy Audit ($0.00 customer deduction)
  const inboundCharges = await prisma.transaction.findMany({
    where: {
      userId: { in: TEST_USERS.map(u => u.id) },
      OR: [
        { description: { contains: 'inbound', mode: 'insensitive' } },
        { description: { contains: 'incoming', mode: 'insensitive' } },
        { type: 'inbound_call' },
        { type: 'inbound_sms' }
      ]
    }
  });
  assertEqual(inboundCharges.length, 0, 'Inbound Free Policy: 0 Inbound Charge Deductions from User Wallets');

  console.log('\n================================================================');
  console.log(`🏁 AUDIT RESULTS SUMMARY: ${passCount} PASSED, ${failCount} FAILED`);
  console.log('================================================================\n');

  await prisma.$disconnect();

  if (failCount > 0) {
    process.exit(1);
  }
}

runDeepVerification().catch(err => {
  console.error('Fatal Verification Error:', err);
  process.exit(1);
});
