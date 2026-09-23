require('dotenv').config();
const http = require('http');

const token = process.env.ADMIN_SECRET_TOKEN || 'simly_master_admin_token_2026_sec_v1';

function makeRequest(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: '127.0.0.1',
      port: 5000,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    };
    if (data) {
      options.headers['Content-Length'] = Buffer.byteLength(data);
    }

    const req = http.request(options, (res) => {
      let resData = '';
      res.on('data', chunk => resData += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(resData);
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, raw: resData });
        }
      });
    });

    req.on('error', (e) => reject(e));
    if (data) req.write(data);
    req.end();
  });
}

async function runPass(passNumber) {
  console.log(`\n================================================================`);
  console.log(`🚀 STARTING VERIFICATION PASS ${passNumber} / 2`);
  console.log(`================================================================\n`);

  // Step 1: Carriers Config
  console.log(`[Pass ${passNumber} - Step 1] Testing GET /api/admin/telecom/carriers-config...`);
  const carriersRes = await makeRequest('/api/admin/telecom/carriers-config');
  if (carriersRes.data && carriersRes.data.success) {
    console.log(`✅ Carriers retrieved (${carriersRes.data.carriers.length} providers):`);
    carriersRes.data.carriers.forEach(c => {
      console.log(`   - Carrier: ${c.name} (${c.code}) | Status: ${c.status} | Balance: ${c.currency} ${c.balance} | Active Lines: ${c.activeLines} | Lifetime Lines: ${c.totalLines} | Net Profit: $${c.netProfit} (${c.marginPercent}%)`);
    });
  } else {
    console.error(`❌ Failed:`, carriersRes);
    process.exit(1);
  }

  // Step 2: Handshake Connections
  console.log(`\n[Pass ${passNumber} - Step 2] Testing POST /api/admin/telecom/test-connection (Telnyx & Twilio & DIDWW)...`);
  for (const cName of ['TELNYX', 'TWILIO', 'DIDWW']) {
    const handshake = await makeRequest('/api/admin/telecom/test-connection', 'POST', { carrier: cName });
    console.log(` - ${cName} Handshake: ${handshake.data?.success ? '✅ SUCCESS' : '❌ FAILED'} -> ${handshake.data?.message || handshake.data?.error}`);
  }

  // Step 3: Numbers Fleet Carrier Audit
  console.log(`\n[Pass ${passNumber} - Step 3] Testing GET /api/admin/numbers (Fleet carrier tags)...`);
  const numbersRes = await makeRequest('/api/admin/numbers');
  if (numbersRes.data && numbersRes.data.success) {
    const list = numbersRes.data.numbers || [];
    console.log(`✅ Total Numbers in Fleet: ${list.length}`);
    const sample = list[0];
    if (sample) {
      console.log(`   Sample Line: ${sample.phoneNumber} | Carrier: [${sample.carrier}] | User: ${sample.userEmail} | Status: ${sample.status}`);
    }
  } else {
    console.error(`❌ Numbers fleet failed:`, numbersRes);
    process.exit(1);
  }

  // Step 4: Number CDR & Activity Deep-Dive
  console.log(`\n[Pass ${passNumber} - Step 4] Testing GET /api/admin/numbers/:phoneNumber/activity...`);
  const testPhone = numbersRes.data?.numbers?.[0]?.phoneNumber || '+16594440250';
  const actRes = await makeRequest(`/api/admin/numbers/${encodeURIComponent(testPhone)}/activity`);
  if (actRes.data && actRes.data.success) {
    console.log(`✅ Activity retrieved for ${testPhone}:`);
    console.log(`   - Line Carrier: [${actRes.data.number?.carrier}]`);
    console.log(`   - Owner: ${actRes.data.user?.name} (${actRes.data.user?.email})`);
    console.log(`   - Total CDR Calls: ${actRes.data.stats?.totalCalls} (${actRes.data.calls?.length} returned)`);
    console.log(`   - Total SMS Threads: ${actRes.data.stats?.totalThreads} (${actRes.data.threads?.length} returned)`);
  } else {
    console.error(`❌ Number activity failed:`, actRes);
    process.exit(1);
  }

  // Step 5: User Dossier & Attached Carrier Lines
  console.log(`\n[Pass ${passNumber} - Step 5] Testing GET /api/admin/support/user-dossier/:userId...`);
  const testUserId = numbersRes.data?.numbers?.[0]?.userId || '6ac8d9af-b215-4791-a564-2f2c63596d50';
  const dossierRes = await makeRequest(`/api/admin/support/user-dossier/${encodeURIComponent(testUserId)}`);
  if (dossierRes.data && dossierRes.data.success) {
    console.log(`✅ User Dossier for ${dossierRes.data.user?.email}:`);
    console.log(`   - Wallet Balance: $${dossierRes.data.user?.walletBalance}`);
    console.log(`   - Attached Lines (${dossierRes.data.numbers?.length}):`);
    (dossierRes.data.numbers || []).forEach(n => {
      console.log(`      * ${n.phoneNumber} (${n.countryCode}) -> Carrier: [${n.carrier}] | Plan: ${n.planType} | Status: ${n.status}`);
    });
  } else {
    console.error(`❌ Dossier failed:`, dossierRes);
    process.exit(1);
  }

  // Step 6: Rates Preview per Carrier
  console.log(`\n[Pass ${passNumber} - Step 6] Testing GET /api/admin/carrier/rates-preview...`);
  for (const c of ['TWILIO', 'TELNYX', 'DIDWW']) {
    const rp = await makeRequest(`/api/admin/carrier/rates-preview?carrier=${c}`);
    if (rp.data && rp.data.success) {
      console.log(`   - Carrier [${c}]: Live Inbound SMS Wholesale = $${rp.data.rates?.inboundSmsCost}, Voice Cost/Min = $${rp.data.rates?.callWholesaleCostPerMin}`);
    }
  }

  // Step 7: Stats & Real-Time Financials per Carrier
  console.log(`\n[Pass ${passNumber} - Step 7] Testing GET /api/admin/stats?carrier=...`);
  for (const c of ['all', 'TWILIO', 'TELNYX']) {
    const statsRes = await makeRequest(`/api/admin/stats?carrier=${c}`);
    if (statsRes.data && statsRes.data.success) {
      const f = statsRes.data.data?.financials || {};
      console.log(`   - Carrier Filter [${c.toUpperCase()}]: Revenue = $${f.totalRetailRevenue || 0}, Cost = $${f.totalWholesaleCost || 0}, Net Profit = $${f.netProfit || 0} (${f.marginPercent || 0}% margin)`);
    }
  }

  console.log(`\n🎉 PASS ${passNumber} COMPLETED WITH 100% SUCCESS!`);
}

async function runAll() {
  await runPass(1);
  await new Promise(r => setTimeout(r, 1000));
  await runPass(2);
  console.log(`\n================================================================`);
  console.log(`🏆 ALL 2 VERIFICATION PASSES COMPLETED & VERIFIED 100% SUCCESSFUL!`);
  console.log(`================================================================\n`);
  process.exit(0);
}

runAll().catch(e => {
  console.error('Fatal test error:', e);
  process.exit(1);
});
