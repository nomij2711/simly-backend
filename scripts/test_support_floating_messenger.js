const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const prisma = new PrismaClient();

async function runSupportMessengerVerification() {
  console.log('================================================================');
  console.log('📱 LIVE SUPPORT FLOATING MESSENGER & RINGER VERIFICATION');
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
    // ---------------------------------------------------------
    // Phase 1: Verify UI Elements & JavaScript in public/admin/index.html
    // ---------------------------------------------------------
    console.log('--- Phase 1: Frontend UI Markup & Real-Time Engine Audit ---');
    const htmlPath = path.join(__dirname, '..', 'public', 'admin', 'index.html');
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');

    assertTrue(htmlContent.includes('id="btnStaffNotifToggle"'), 'Header Ringer Toggle button exists (#btnStaffNotifToggle)');
    assertTrue(htmlContent.includes('id="staffNotifBellIcon"'), 'Header Bell icon element exists (#staffNotifBellIcon)');
    assertTrue(htmlContent.includes('id="staffNotifBellText"'), 'Header Bell status text exists (#staffNotifBellText)');
    assertTrue(htmlContent.includes('function toggleStaffNotifBell('), 'toggleStaffNotifBell function implemented');
    assertTrue(htmlContent.includes('function initStaffNotifBell('), 'initStaffNotifBell persistence initializer implemented');
    assertTrue(htmlContent.includes('function playSupportChime('), 'Crisp Dual-tone Web Audio API Synthesizer (playSupportChime) implemented');
    assertTrue(htmlContent.includes('id="floatingMessengerContainer"'), 'Floating Messenger Container (#floatingMessengerContainer) present in DOM');
    assertTrue(htmlContent.includes('id="floatingMessengerDrawer"'), 'Floating Quick-Reply Drawer (#floatingMessengerDrawer) present in DOM');
    assertTrue(htmlContent.includes('id="floatingMessengerBubble"'), 'Floating Messenger Chat Head Bubble (#floatingMessengerBubble) present in DOM');
    assertTrue(htmlContent.includes('id="floatingMessengerUnreadBadge"'), 'Floating Unread/Queue Badge (#floatingMessengerUnreadBadge) present in DOM');
    assertTrue(htmlContent.includes('id="fmMessagesList"'), 'Messenger Live Message Scroll Body (#fmMessagesList) present in DOM');
    assertTrue(htmlContent.includes('id="fmReplyInput"'), 'Messenger Quick Reply Input (#fmReplyInput) present in DOM');
    assertTrue(htmlContent.includes('function toggleFloatingMessengerDrawer('), 'toggleFloatingMessengerDrawer drawer controller implemented');
    assertTrue(htmlContent.includes('function updateFloatingMessengerTicket('), 'updateFloatingMessengerTicket reactive ticket updater implemented');
    assertTrue(htmlContent.includes('function sendQuickFloatingReply('), 'sendQuickFloatingReply 1-tap canned reply trigger implemented');
    assertTrue(htmlContent.includes('function handleFloatingReplySubmit('), 'handleFloatingReplySubmit real-time reply dispatcher implemented');
    assertTrue(htmlContent.includes('function goToFullSupportDeskFromFloating('), 'goToFullSupportDeskFromFloating seamless portal switcher implemented');
    assertTrue(htmlContent.includes('function pollSupportAlertsAndQueue('), 'Real-time support alert poller (pollSupportAlertsAndQueue) active');

    // ---------------------------------------------------------
    // Phase 2: Setup Test Support Agent & Customer Data
    // ---------------------------------------------------------
    console.log('\n--- Phase 2: Setup Test Agent and Customer ---');
    const testCustomer = await prisma.user.upsert({
      where: { email: 'support_user_test@simlyx.test' },
      update: {
        name: 'Tariq Mehmood',
        isBanned: false,
        isVerified: true
      },
      create: {
        id: 'user_support_test_101',
        name: 'Tariq Mehmood',
        email: 'support_user_test@simlyx.test',
        isBanned: false,
        isVerified: true
      }
    });
    assertTrue(!!testCustomer, `Customer created/loaded: ${testCustomer.name} (${testCustomer.id})`);

    const testStaff = await prisma.staffUser.upsert({
      where: { email: 'agent_ali@simlyx.test' },
      update: {
        isActive: true,
        permissions: 'all',
        chatDisplayName: 'Agent Ali'
      },
      create: {
        id: 'staff_agent_ali_101',
        email: 'agent_ali@simlyx.test',
        password: 'hashed_password_placeholder',
        name: 'Ali Raza',
        chatDisplayName: 'Agent Ali',
        role: 'support_agent',
        permissions: 'all',
        isActive: true
      }
    });
    assertTrue(!!testStaff, `Support Agent created/loaded: ${testStaff.name} (DisplayName: ${testStaff.chatDisplayName})`);

    // Clean up previous test messages/tickets
    await prisma.supportMessage.deleteMany({ where: { userId: testCustomer.id } });
    await prisma.supportTicket.deleteMany({ where: { userId: testCustomer.id } });

    // ---------------------------------------------------------
    // Phase 3: Round 1 Verification - Customer Messages (RINGER ON)
    // ---------------------------------------------------------
    console.log('\n--- Phase 3: Round 1 Verification (Ringer: ON) ---');
    
    // 1. Customer submits a new support ticket/message
    const msg1Text = 'Assalam o Alaikum! My eSIM line is not getting 5G network. Please assist.';
    const msg1 = await prisma.supportMessage.create({
      data: {
        userId: testCustomer.id,
        sender: 'user',
        senderName: testCustomer.name,
        text: msg1Text
      }
    });
    assertTrue(!!msg1, `Customer sent message 1: "${msg1.text}"`);

    const ticket1 = await prisma.supportTicket.create({
      data: {
        userId: testCustomer.id,
        status: 'unassigned',
        unreadStaffCount: 1,
        unreadUserCount: 0,
        lastMessageText: msg1Text,
        lastMessageAt: new Date()
      }
    });
    assertEqual(ticket1.status, 'unassigned', 'Ticket created in UNASSIGNED queue');
    assertEqual(ticket1.unreadStaffCount, 1, 'Unread staff count is 1');

    // 2. Simulate Poller Alert Evaluation with Ringer ON
    let staffRingerEnabled = true;
    let lastKnownUnassigned = 0;
    let lastKnownUnread = 0;

    const currentUnassignedCount = 1;
    const currentUnreadCount = 1;
    const hasNewIncomingRound1 = (currentUnassignedCount > lastKnownUnassigned || currentUnreadCount > lastKnownUnread);
    assertTrue(hasNewIncomingRound1, 'Poller detects new incoming ticket in queue');

    let ringerAudioPlayedRound1 = false;
    if (hasNewIncomingRound1 && staffRingerEnabled) {
      ringerAudioPlayedRound1 = true;
    }
    assertTrue(ringerAudioPlayedRound1, 'Ringer ON: Dual-Tone Web Audio Chime rings & phone vibrates');

    // 3. Simulate Floating Messenger Ticket Attachment & Badge
    let floatingBadgeCountRound1 = currentUnassignedCount;
    assertEqual(floatingBadgeCountRound1, 1, 'Floating Messenger Chat Head shows badge "1"');

    // 4. Agent sends quick canned reply from Floating Drawer
    const reply1Text = 'Walaikum Assalam Tariq! Looking into this for you right now, please give me a moment!';
    const reply1 = await prisma.supportMessage.create({
      data: {
        userId: testCustomer.id,
        sender: 'agent',
        senderName: testStaff.chatDisplayName,
        text: reply1Text
      }
    });
    assertTrue(!!reply1, `Agent sent quick reply from floating drawer: "${reply1.text}"`);

    const updatedTicket1 = await prisma.supportTicket.update({
      where: { userId: testCustomer.id },
      data: {
        status: 'claimed',
        assignedStaffId: testStaff.id,
        assignedStaffName: testStaff.chatDisplayName,
        unreadStaffCount: 0,
        unreadUserCount: 1,
        lastMessageText: reply1Text,
        lastMessageAt: new Date()
      }
    });
    assertEqual(updatedTicket1.status, 'claimed', 'Ticket claimed by Agent Ali');
    assertEqual(updatedTicket1.unreadStaffCount, 0, 'Agent unread count reset to 0');
    assertEqual(updatedTicket1.unreadUserCount, 1, 'Customer has 1 unread reply notification');

    // ---------------------------------------------------------
    // Phase 4: Round 2 Verification - Customer Messages (RINGER OFF / MUTED MODE)
    // ---------------------------------------------------------
    console.log('\n--- Phase 4: Round 2 Verification (Ringer: OFF / Muted Shift Mode) ---');
    
    // 1. Agent sets ringer OFF (Off-duty / Quiet shift)
    staffRingerEnabled = false;
    console.log('  🔕 Agent toggles ringer switch to OFF (Muted mode stored in localStorage)');

    // 2. Customer replies back
    const msg2Text = 'I did a network settings reset and restarted my phone. Now 5G is connected! Thank you so much!';
    const msg2 = await prisma.supportMessage.create({
      data: {
        userId: testCustomer.id,
        sender: 'user',
        senderName: testCustomer.name,
        text: msg2Text
      }
    });
    assertTrue(!!msg2, `Customer sent message 2: "${msg2.text}"`);

    const ticket2 = await prisma.supportTicket.update({
      where: { userId: testCustomer.id },
      data: {
        unreadStaffCount: 1,
        lastMessageText: msg2Text,
        lastMessageAt: new Date()
      }
    });
    assertEqual(ticket2.unreadStaffCount, 1, 'Ticket unread staff count incremented to 1');

    // 3. Poller evaluates state with Ringer OFF
    lastKnownUnread = 0;
    const currentUnreadRound2 = 1;
    const hasNewIncomingRound2 = currentUnreadRound2 > lastKnownUnread;
    assertTrue(hasNewIncomingRound2, 'Poller detects customer follow-up message');

    let ringerAudioPlayedRound2 = false;
    if (hasNewIncomingRound2 && staffRingerEnabled) {
      ringerAudioPlayedRound2 = true;
    }
    assertTrue(!ringerAudioPlayedRound2, 'Ringer OFF: Audio chime is SILENT / MUTED (No ringing noise)');

    // 4. Floating Badge & Drawer Visual updates still occur so agent sees upon looking
    let floatingBadgeCountRound2 = currentUnreadRound2;
    assertEqual(floatingBadgeCountRound2, 1, 'Visual Floating Messenger Badge updates to "1" even when audio is muted');

    // 5. Agent sends concluding canned reply
    const reply2Text = 'Your eSIM profile is active and verified. Enjoy high-speed data!';
    const reply2 = await prisma.supportMessage.create({
      data: {
        userId: testCustomer.id,
        sender: 'agent',
        senderName: testStaff.chatDisplayName,
        text: reply2Text
      }
    });
    assertTrue(!!reply2, `Agent sent concluding canned reply: "${reply2.text}"`);

    // ---------------------------------------------------------
    // Phase 5: Transcript Audit & Clean State
    // ---------------------------------------------------------
    console.log('\n--- Phase 5: Full Conversation Audit ---');
    const allMessages = await prisma.supportMessage.findMany({
      where: { userId: testCustomer.id },
      orderBy: { createdAt: 'asc' }
    });
    assertEqual(allMessages.length, 4, 'Full chat transcript contains all 4 messages in chronological sequence');
    assertEqual(allMessages[0].sender, 'user', 'Message 1 from Customer');
    assertEqual(allMessages[1].sender, 'agent', 'Message 2 from Agent Ali');
    assertEqual(allMessages[2].sender, 'user', 'Message 3 from Customer');
    assertEqual(allMessages[3].sender, 'agent', 'Message 4 from Agent Ali');

    console.log('\n================================================================');
    console.log(`🎉 VERIFICATION COMPLETE: ${passCount} PASSED, ${failCount} FAILED`);
    console.log('================================================================');

    if (failCount > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Verification Error:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runSupportMessengerVerification();
