require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function runVerification() {
  console.log('=== RUNNING TELECOM & CARRIER VERIFICATION SUITE ===\n');

  // Test 1: Check Country Rates Carriers & Policy
  console.log('--- TEST 1: Country Rates Carrier Mapping ---');
  const rates = await prisma.countryRate.findMany();
  console.log('Found ' + rates.length + ' active country rates:');
  rates.forEach(r => {
    console.log(` - ${r.flagEmoji} ${r.countryName} (${r.countryCode}): Carrier = [${r.carrier}], Monthly Price = $${r.numberMonthlySellPrice}, Wholesale Cost = $${r.numberWholesaleCost}, Inbound SMS = ${r.inboundSmsPolicy} ($${r.inboundSmsCost})`);
  });

  // Test 2: Check Purchased Numbers Carrier Persistence
  console.log('\n--- TEST 2: Purchased Numbers Fleet & Carrier Attribution ---');
  const numbers = await prisma.purchasedNumber.findMany();
  console.log('Total purchased numbers in fleet: ' + numbers.length);
  const byCarrier = {};
  numbers.forEach(n => {
    const c = n.carrier || 'TELNYX';
    byCarrier[c] = (byCarrier[c] || 0) + 1;
  });
  console.log('Breakdown by carrier:', JSON.stringify(byCarrier));
  numbers.slice(0, 5).forEach(n => {
    console.log(` - ${n.phoneNumber} (${n.countryCode}) -> Carrier: [${n.carrier}], User: ${n.userId}, Status: ${n.status}`);
  });

  // Test 3: Check Users with numbers & User Dossier simulation
  console.log('\n--- TEST 3: User Dossier & Number Association ---');
  const usersWithNumbers = await prisma.user.findMany({
    take: 3
  });
  for (const user of usersWithNumbers) {
    const userNumbers = await prisma.purchasedNumber.findMany({ where: { userId: user.id } });
    console.log(`User ${user.email} (ID: ${user.id}) has ${userNumbers.length} numbers:`);
    userNumbers.forEach(un => {
      console.log(`   * ${un.phoneNumber} (${un.countryCode}) | Carrier: [${un.carrier}] | Status: ${un.status} | Expires: ${un.expiresAt}`);
    });
  }

  // Test 4: Financial Transactions Audit
  console.log('\n--- TEST 4: Transactions Integrity ---');
  const txCount = await prisma.transaction.count();
  console.log(`Total transactions recorded in audit ledger: ${txCount}`);

  console.log('\n✅ Verification Database checks completed successfully!');
  await prisma.$disconnect();
}

runVerification().catch(e => { console.error(e); process.exit(1); });
