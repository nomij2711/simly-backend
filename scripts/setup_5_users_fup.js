const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Helper to normalize phone numbers
const normalizePhone = (num) => (num ? num.toString().trim().replace(/^ /, '+') : num);

const TEST_5_USERS = [
  { id: 'fup_u1_normal_ali', name: 'Ali (Normal Profitable)', email: 'ali_normal@simlyx.test', phone: '+12025550201', carrier: 'TELNYX', country: 'US', plan: '30_days', buyPrice: 3.25 },
  { id: 'fup_u2_normal_sara', name: 'Sara (Active Business UK)', email: 'sara_business@simlyx.test', phone: '+447700900202', carrier: 'TWILIO', country: 'GB', plan: '30_days', buyPrice: 4.50 },
  { id: 'fup_u3_normal_zain', name: 'Zain (Dual Line Balanced)', email: 'zain_dual@simlyx.test', phone: '+12025550203', carrier: 'TELNYX', country: 'US', plan: '30_days', buyPrice: 3.00 },
  { id: 'fup_u4_abuse_flood', name: 'Abuse 1: Flood Bot (15 in 30s)', email: 'flood_bot@simlyx.test', phone: '+12025550204', carrier: 'TELNYX', country: 'US', plan: '30_days', buyPrice: 2.00 },
  { id: 'fup_u5_abuse_drain', name: 'Abuse 2: Margin Drainer (-85%)', email: 'drain_bot@simlyx.test', phone: '+447700900205', carrier: 'TWILIO', country: 'GB', plan: '30_days', buyPrice: 1.00 }
];

async function setup5UsersFup() {
  console.log('================================================================');
  console.log('🚀 INITIALIZING 5-USER FUP & ABUSE LIFECYCLE TEST SUITE');
  console.log('================================================================\n');

  // Clean previous test data
  const testIds = TEST_5_USERS.map(u => u.id);
  const testPhones = TEST_5_USERS.map(u => u.phone);

  await prisma.message.deleteMany({ where: { OR: [{ fromNumber: { in: testPhones } }, { toNumber: { in: testPhones } }] } });
  await prisma.callLog.deleteMany({ where: { OR: [{ myNumber: { in: testPhones } }, { contactNumber: { in: testPhones } }] } });
  await prisma.transaction.deleteMany({ where: { userId: { in: testIds } } });
  await prisma.purchasedNumber.deleteMany({ where: { userId: { in: testIds } } });
  await prisma.user.deleteMany({ where: { id: { in: testIds } } });

  console.log('🧹 Cleaned previous test state.');

  for (const u of TEST_5_USERS) {
    await prisma.user.create({
      data: {
        id: u.id,
        name: u.name,
        email: u.email,
        walletBalance: 20.0
      }
    });

    await prisma.purchasedNumber.create({
      data: {
        id: `line_${u.id}`,
        phoneNumber: u.phone,
        userId: u.id,
        countryCode: u.country,
        carrier: u.carrier,
        planType: u.plan,
        status: 'active'
      }
    });

    await prisma.transaction.create({
      data: {
        userId: u.id,
        type: 'number_purchase',
        amount: -u.buyPrice,
        description: `Line Purchase: ${u.phone} (${u.country} ${u.plan})`
      }
    });
  }

  console.log('✅ Created 5 Test Users and Virtual Lines.\n');

  // Populate User 1 (Normal Ali): 2 Outbound calls, 2 Outbound SMS, 2 Inbound calls (2 mins), 3 Inbound SMS
  await prisma.transaction.create({ data: { userId: 'fup_u1_normal_ali', type: 'call_charge', amount: -0.18, description: 'Outbound Call (2 min)' } });
  await prisma.callLog.create({ data: { myNumber: '+12025550201', contactNumber: '+18005550111', direction: 'outbound', status: 'completed', durationSeconds: 120 } });
  await prisma.transaction.create({ data: { userId: 'fup_u1_normal_ali', type: 'sms_charge', amount: -0.06, description: 'Outbound SMS (2 msgs)' } });
  await prisma.message.create({ data: { fromNumber: '+12025550201', toNumber: '+18005550111', text: 'Hello', direction: 'outbound' } });
  await prisma.message.create({ data: { fromNumber: '+12025550201', toNumber: '+18005550111', text: 'How are you?', direction: 'outbound' } });
  // Inbound normal
  await prisma.callLog.create({ data: { myNumber: '+12025550201', contactNumber: '+18005550111', direction: 'inbound', status: 'completed', durationSeconds: 120 } });
  await prisma.message.create({ data: { fromNumber: '+18005550111', toNumber: '+12025550201', text: 'OTP 1234', direction: 'inbound' } });
  await prisma.message.create({ data: { fromNumber: '+18005550111', toNumber: '+12025550201', text: 'OTP 5678', direction: 'inbound' } });
  await prisma.message.create({ data: { fromNumber: '+18005550111', toNumber: '+12025550201', text: 'Bank Alert', direction: 'inbound' } });

  // Populate User 2 (Sara UK Business): High outbound revenue ($3.60) + Inbound business
  await prisma.transaction.create({ data: { userId: 'fup_u2_normal_sara', type: 'call_charge', amount: -2.70, description: 'Outbound Business Calls (30 min)' } });
  await prisma.callLog.create({ data: { myNumber: '+447700900202', contactNumber: '+442079460111', direction: 'outbound', status: 'completed', durationSeconds: 1800 } });
  await prisma.callLog.create({ data: { myNumber: '+447700900202', contactNumber: '+442079460111', direction: 'inbound', status: 'completed', durationSeconds: 600 } });
  for (let i = 0; i < 8; i++) {
    await prisma.message.create({ data: { fromNumber: '+442079460111', toNumber: '+447700900202', text: `Customer inquiry #${i}`, direction: 'inbound' } });
  }

  // Populate User 3 (Zain Dual Line): Balanced normal
  await prisma.callLog.create({ data: { myNumber: '+12025550203', contactNumber: '+18005550333', direction: 'inbound', status: 'completed', durationSeconds: 60 } });
  await prisma.message.create({ data: { fromNumber: '+18005550333', toNumber: '+12025550203', text: 'Verification code 9988', direction: 'inbound' } });

  // Populate User 5 (Abusive Drainer): Massive inbound calls (25 mins @ $0.0100 = $0.25) + 80 Inbound SMS on Twilio ($0.60) = $1.85 cost vs $1.00 rev = -$0.85 loss (-85%)
  for (let i = 0; i < 5; i++) {
    await prisma.callLog.create({ data: { myNumber: '+447700900205', contactNumber: '+442079460999', direction: 'inbound', status: 'completed', durationSeconds: 300 } });
  }
  for (let i = 0; i < 80; i++) {
    await prisma.message.create({ data: { fromNumber: '+442079460999', toNumber: '+447700900205', text: `OTP spam #${i}`, direction: 'inbound' } });
  }

  console.log('📡 Traffic Matrix successfully generated for all 5 users.');
}

module.exports = { setup5UsersFup, TEST_5_USERS };
