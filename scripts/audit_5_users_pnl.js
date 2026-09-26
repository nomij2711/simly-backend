const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Import PnL calculation function from server.js
// We will test directly and verify data integrity
const TEST_USERS = [
  {
    id: 'audit_u1_us_telnyx',
    name: 'Audit User 1 (US Telnyx)',
    email: 'audit1_telnyx_us@simlyx.test',
    phone: '+13125550101',
    walletBalance: 25.00,
    number: '+13125550101',
    countryCode: 'US',
    carrier: 'TELNYX',
    planType: '30_days',
    retailPrice: 1.50,
    wholesaleCost: 0.90
  },
  {
    id: 'audit_u2_uk_twilio',
    name: 'Audit User 2 (UK Twilio)',
    email: 'audit2_twilio_uk@simlyx.test',
    phone: '+447700900202',
    walletBalance: 30.00,
    number: '+447700900202',
    countryCode: 'GB',
    carrier: 'TWILIO',
    planType: '30_days',
    retailPrice: 2.50,
    wholesaleCost: 1.15
  },
  {
    id: 'audit_u3_heavy_inbound_call',
    name: 'Audit User 3 (Heavy Inbound Voice)',
    email: 'audit3_inbound_voice@simlyx.test',
    phone: '+14155550303',
    walletBalance: 15.00,
    number: '+14155550303',
    countryCode: 'US',
    carrier: 'TELNYX',
    planType: '30_days',
    retailPrice: 1.50,
    wholesaleCost: 0.90
  },
  {
    id: 'audit_u4_heavy_inbound_sms',
    name: 'Audit User 4 (Heavy Inbound SMS)',
    email: 'audit4_inbound_sms@simlyx.test',
    phone: '+447700900404',
    number: '+447700900404',
    carrier: 'TWILIO',
    countryCode: 'GB',
    planType: '30_days',
    retailPrice: 2.50,
    wholesaleCost: 1.15
  },
  {
    id: 'audit_u5_dual_line_cross',
    name: 'Audit User 5 (Dual US+UK Carrier)',
    email: 'audit5_dual_carrier@simlyx.test',
    phone: '+12125550505',
    walletBalance: 50.00,
    numbers: [
      { phoneNumber: '+12125550505', countryCode: 'US', carrier: 'TELNYX', planType: '30_days', retailPrice: 1.50, wholesaleCost: 0.90 },
      { phoneNumber: '+447700900505', countryCode: 'GB', carrier: 'TWILIO', planType: '30_days', retailPrice: 2.50, wholesaleCost: 1.15 }
    ]
  }
];

async function setupAuditData() {
  console.log('================================================================');
  console.log('🚀 INITIALIZING 5-USER TELECOM P&L DEEP AUDIT SUITE');
  console.log('================================================================');

  // 1. Clean up prior audit records if any
  const auditEmails = TEST_USERS.map(u => u.email);
  const auditUserIds = TEST_USERS.map(u => u.id);
  const auditPhoneNumbers = [
    '+13125550101', '+447700900202', '+14155550303', '+447700900404', '+12125550505', '+447700900505'
  ];

  await prisma.transaction.deleteMany({ where: { userId: { in: auditUserIds } } });
  await prisma.callLog.deleteMany({ where: { OR: [{ myNumber: { in: auditPhoneNumbers } }, { contactNumber: { in: auditPhoneNumbers } }] } });
  await prisma.message.deleteMany({ where: { OR: [{ fromNumber: { in: auditPhoneNumbers } }, { toNumber: { in: auditPhoneNumbers } }] } });
  await prisma.purchasedNumber.deleteMany({ where: { userId: { in: auditUserIds } } });
  await prisma.user.deleteMany({ where: { email: { in: auditEmails } } });

  console.log('🧹 Cleaned previous audit state.');

  // 2. Insert 5 Audit Users
  for (const u of TEST_USERS) {
    await prisma.user.create({
      data: {
        id: u.id,
        name: u.name,
        email: u.email,
        phone: u.phone,
        walletBalance: u.walletBalance || 20.0
      }
    });

    // Assign Numbers & Line Purchase Transactions
    if (u.numbers) {
      for (const n of u.numbers) {
        await prisma.purchasedNumber.create({
          data: {
            phoneNumber: n.phoneNumber,
            userId: u.id,
            countryCode: n.countryCode,
            carrier: n.carrier,
            planType: n.planType,
            status: 'active'
          }
        });
        await prisma.transaction.create({
          data: {
            userId: u.id,
            type: 'number_purchase',
            amount: -n.retailPrice,
            description: `Purchased Line ${n.phoneNumber} [${n.carrier}] (${n.countryCode}) - ${n.planType}`
          }
        });
      }
    } else {
      await prisma.purchasedNumber.create({
        data: {
          phoneNumber: u.number,
          userId: u.id,
          countryCode: u.countryCode,
          carrier: u.carrier,
          planType: u.planType,
          status: 'active'
        }
      });
      await prisma.transaction.create({
        data: {
          userId: u.id,
          type: 'number_purchase',
          amount: -u.retailPrice,
          description: `Purchased Line ${u.number} [${u.carrier}] (${u.countryCode}) - ${u.planType}`
        }
      });
    }
  }

  console.log('✅ Created 5 Test Users and Virtual Lines.');

  // 3. Populate Controlled Call & SMS Traffic
  console.log('\n📡 GENERATING TRAFFIC MATRIX:');

  // --- USER 1 (US Telnyx) ---
  // Outbound Call: 2 calls (Call A: 45s = 1 min to UK @ $0.09 retail, $0.014 wholesale. Call B: 125s = 3 mins to US @ $0.05 retail, $0.005 wholesale)
  await prisma.callLog.create({
    data: { myNumber: '+13125550101', contactNumber: '+447700900999', direction: 'outbound', status: 'completed', durationSeconds: 45 }
  });
  await prisma.transaction.create({
    data: { userId: 'audit_u1_us_telnyx', type: 'call_charge', amount: -0.09, description: 'Call to +447700900999 (1 min)' }
  });

  await prisma.callLog.create({
    data: { myNumber: '+13125550101', contactNumber: '+13125550999', direction: 'outbound', status: 'completed', durationSeconds: 125 }
  });
  await prisma.transaction.create({
    data: { userId: 'audit_u1_us_telnyx', type: 'call_charge', amount: -0.15, description: 'Call to +13125550999 (3 mins)' }
  });

  // Outbound SMS: 2 messages @ $0.03 retail, $0.0020 wholesale
  await prisma.message.create({
    data: { fromNumber: '+13125550101', toNumber: '+13125550999', text: 'Hello from Telnyx US', direction: 'outbound', status: 'delivered' }
  });
  await prisma.transaction.create({
    data: { userId: 'audit_u1_us_telnyx', type: 'sms_charge', amount: -0.03, description: 'SMS to +13125550999' }
  });

  await prisma.message.create({
    data: { fromNumber: '+13125550101', toNumber: '+447700900999', text: 'Hi UK friend', direction: 'outbound', status: 'delivered' }
  });
  await prisma.transaction.create({
    data: { userId: 'audit_u1_us_telnyx', type: 'sms_charge', amount: -0.05, description: 'SMS to +447700900999' }
  });

  // Inbound Call: 1 incoming call (30s = 1 min on US Telnyx -> $0.00 user, $0.0050 wholesale)
  await prisma.callLog.create({
    data: { myNumber: '+13125550101', contactNumber: '+18005550199', direction: 'inbound', status: 'completed', durationSeconds: 30 }
  });

  // Inbound SMS: 2 incoming SMS (2 msgs on US Telnyx -> $0.00 user, 2 x $0.0020 = $0.0040 wholesale)
  await prisma.message.create({
    data: { fromNumber: '+18005550199', toNumber: '+13125550101', text: 'OTP 123456', direction: 'inbound', status: 'received' }
  });
  await prisma.message.create({
    data: { fromNumber: '+18005550199', toNumber: '+13125550101', text: 'Your verification code is 8899', direction: 'inbound', status: 'received' }
  });
  console.log(' - User 1 (US Telnyx) traffic generated.');


  // --- USER 2 (UK Twilio) ---
  // Outbound Call: 1 call (80s = 2 mins to US @ $0.09 retail/min = $0.18, wholesale $0.0050/min = $0.0100)
  await prisma.callLog.create({
    data: { myNumber: '+447700900202', contactNumber: '+13125550999', direction: 'outbound', status: 'completed', durationSeconds: 80 }
  });
  await prisma.transaction.create({
    data: { userId: 'audit_u2_uk_twilio', type: 'call_charge', amount: -0.18, description: 'Call to +13125550999 (2 mins)' }
  });

  // Outbound SMS: 1 message @ $0.04 retail, $0.0075 Twilio wholesale
  await prisma.message.create({
    data: { fromNumber: '+447700900202', toNumber: '+447700900888', text: 'UK outbound text', direction: 'outbound', status: 'delivered' }
  });
  await prisma.transaction.create({
    data: { userId: 'audit_u2_uk_twilio', type: 'sms_charge', amount: -0.04, description: 'SMS to +447700900888' }
  });

  // Inbound Call: 1 incoming call (120s = 2 mins on UK Twilio -> $0.00 user, 2 x $0.0100 = $0.0200 wholesale)
  await prisma.callLog.create({
    data: { myNumber: '+447700900202', contactNumber: '+447700900777', direction: 'inbound', status: 'completed', durationSeconds: 120 }
  });

  // Inbound SMS: 3 incoming SMS on UK Twilio (3 msgs -> $0.00 user, 3 x $0.0075 = $0.0225 wholesale)
  for (let i = 1; i <= 3; i++) {
    await prisma.message.create({
      data: { fromNumber: '+447700900777', toNumber: '+447700900202', text: `UK Inbound Alert #${i}`, direction: 'inbound', status: 'received' }
    });
  }
  console.log(' - User 2 (UK Twilio) traffic generated.');


  // --- USER 3 (Heavy Inbound Voice - Stress Test) ---
  // 5 Inbound calls of 300s (5 mins each) = 25 minutes on US Telnyx (25 x $0.0050 = $0.1250 wholesale)
  // + 1 Inbound call of 600s (10 mins) = 10 minutes on US Telnyx (10 x $0.0050 = $0.0500 wholesale)
  // Total Inbound Voice: 35 minutes -> $0.1750 wholesale cost
  for (let i = 1; i <= 5; i++) {
    await prisma.callLog.create({
      data: { myNumber: '+14155550303', contactNumber: `+1800555030${i}`, direction: 'inbound', status: 'completed', durationSeconds: 300 }
    });
  }
  await prisma.callLog.create({
    data: { myNumber: '+14155550303', contactNumber: '+18005550399', direction: 'inbound', status: 'completed', durationSeconds: 600 }
  });
  console.log(' - User 3 (Heavy Inbound Voice: 35 mins) traffic generated.');


  // --- USER 4 (Heavy Inbound SMS - Stress Test) ---
  // 30 Inbound SMS on UK Twilio (30 x $0.0075 = $0.2250 wholesale cost)
  for (let i = 1; i <= 30; i++) {
    await prisma.message.create({
      data: { fromNumber: `+4477009990${i % 10}`, toNumber: '+447700900404', text: `Verification Alert #${i} code: ${100000 + i}`, direction: 'inbound', status: 'received' }
    });
  }
  console.log(' - User 4 (Heavy Inbound SMS: 30 msgs) traffic generated.');


  // --- USER 5 (Dual Line Cross Carrier) ---
  // Outbound call from US Telnyx (+12125550505) to UK (60s = 1 min -> $0.09 retail, $0.014 wholesale)
  await prisma.callLog.create({
    data: { myNumber: '+12125550505', contactNumber: '+447700900111', direction: 'outbound', status: 'completed', durationSeconds: 60 }
  });
  await prisma.transaction.create({
    data: { userId: 'audit_u5_dual_line_cross', type: 'call_charge', amount: -0.09, description: 'Call from +12125550505 to +447700900111' }
  });

  // Outbound SMS from UK Twilio (+447700900505) to US (1 msg -> $0.04 retail, $0.0075 wholesale)
  await prisma.message.create({
    data: { fromNumber: '+447700900505', toNumber: '+13125550888', text: 'Dual Line SMS Outbound', direction: 'outbound', status: 'delivered' }
  });
  await prisma.transaction.create({
    data: { userId: 'audit_u5_dual_line_cross', type: 'sms_charge', amount: -0.04, description: 'SMS from +447700900505 to +13125550888' }
  });

  // Inbound Call on UK Twilio (+447700900505): 180s = 3 mins -> 3 x $0.0100 = $0.0300 wholesale
  await prisma.callLog.create({
    data: { myNumber: '+447700900505', contactNumber: '+447700900222', direction: 'inbound', status: 'completed', durationSeconds: 180 }
  });

  // Inbound SMS on US Telnyx (+12125550505): 5 msgs -> 5 x $0.0020 = $0.0100 wholesale
  for (let i = 1; i <= 5; i++) {
    await prisma.message.create({
      data: { fromNumber: '+18005550777', toNumber: '+12125550505', text: `Dual Line Inbound US SMS #${i}`, direction: 'inbound', status: 'received' }
    });
  }
  console.log(' - User 5 (Dual US+UK Cross Carrier) traffic generated.');

  console.log('\n================================================================');
  console.log('🎯 SETUP COMPLETED SUCCESSFULLY. STARTING VERIFICATION PASSES.');
  console.log('================================================================\n');
}

module.exports = { setupAuditData, TEST_USERS };
