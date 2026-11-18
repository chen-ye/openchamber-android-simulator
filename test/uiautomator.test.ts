import { describe, expect, test } from 'bun:test';
import { parseAdbDevicesOutput } from '../src/core/adb.ts';
import { withDeviceLock } from '../src/core/controller.ts';
import { matchUiNodes, parseUiHierarchyXml } from '../src/core/uiautomator.ts';

describe('parseUiHierarchyXml', () => {
  test('extracts interactive & labeled nodes, hierarchy depth, hidden/offScreen flags, and decoded entities', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.openchamber.ptt" bounds="[0,0][1080,2400]" clickable="false">
    <node index="0" text="Arm &amp; Listen" resource-id="com.openchamber.ptt:id/arm_btn" class="android.widget.Button" content-desc="Arm PTT" clickable="true" selected="true" enabled="true" bounds="[100,1800][980,1960]" />
    <node index="1" text="" class="android.view.View" clickable="false" bounds="[0,0][1080,100]" />
    <node index="2" text="secret" password="true" class="android.widget.EditText" clickable="true" focused="true" bounds="[80,400][1000,520]" />
    <node index="3" text="Offscreen" clickable="true" bounds="[1200,400][1500,520]" />
    <node index="4" text="Hidden" clickable="true" visible-to-user="false" bounds="[80,600][400,700]" />
  </node>
</hierarchy>`;

    const nodes = parseUiHierarchyXml(xml, { screen: { width: 1080, height: 2400 } });
    expect(nodes).toHaveLength(4);

    expect(nodes[0]).toMatchObject({
      index: 1,
      depth: 0,
      parentIndex: null,
      text: 'Arm & Listen',
      contentDesc: 'Arm PTT',
      resourceId: 'com.openchamber.ptt:id/arm_btn',
      clickable: true,
      selected: true,
      editable: false,
      hidden: false,
      offScreen: false,
      center: { x: 540, y: 1880 },
    });

    expect(nodes[1]).toMatchObject({
      index: 2,
      password: true,
      editable: true,
      focused: true,
    });

    expect(nodes[2]?.offScreen).toBe(true);
    expect(nodes[3]?.hidden).toBe(true);
  });

  test('supports nested tree mode and semantic selector matching', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.LinearLayout" scrollable="true" bounds="[0,0][1080,2400]">
    <node text="Settings" resource-id="app:id/nav_settings" clickable="true" bounds="[0,100][500,200]" />
    <node text="Profile" content-desc="Open Profile" clickable="true" bounds="[0,220][500,320]" />
    <node text="Hidden Item" visible-to-user="false" clickable="true" bounds="[0,340][500,440]" />
  </node>
</hierarchy>`;

    const tree = parseUiHierarchyXml(xml, { tree: true, screen: { width: 1080, height: 2400 } });
    expect(tree).toHaveLength(1);
    expect(tree[0]?.children).toHaveLength(3);
    expect(tree[0]?.children?.[0]?.parentIndex).toBe(1);

    expect(matchUiNodes(tree, 'text=settings,clickable=true').map((n) => n.text)).toEqual(['Settings']);
    expect(matchUiNodes(tree, 'id=nav_settings').map((n) => n.text)).toEqual(['Settings']);
    expect(matchUiNodes(tree, 'desc=/open profile/i').map((n) => n.text)).toEqual(['Profile']);
    // Hidden nodes are excluded unless explicitly matched
    expect(matchUiNodes(tree, 'text=Hidden Item')).toHaveLength(0);
    expect(matchUiNodes(tree, 'text=Hidden Item,hidden=true')).toHaveLength(1);
  });
});

describe('withDeviceLock', () => {
  test('serializes concurrent work per device serial', async () => {
    const events: string[] = [];
    await Promise.all([
      withDeviceLock('emu-1', async () => {
        events.push('a:start');
        await new Promise((r) => setTimeout(r, 25));
        events.push('a:end');
      }),
      withDeviceLock('emu-1', async () => {
        events.push('b:start');
        events.push('b:end');
      }),
    ]);
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });
});

describe('parseAdbDevicesOutput', () => {
  test('classifies local emulator, USB, and TCP devices', () => {
    const out = `List of devices attached
emulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1
192.0.2.10:5555        device product:husky model:Pixel_8_Pro device:husky transport_id:2
R5CR123456X            unauthorized usb:1-2 transport_id:3
`;
    const rows = parseAdbDevicesOutput(out);
    expect(rows).toEqual([
      { serial: 'emulator-5554', rawState: 'device', model: 'sdk gphone64 x86 64', transport: 'local' },
      { serial: '192.0.2.10:5555', rawState: 'device', model: 'Pixel 8 Pro', transport: 'tcp' },
      { serial: 'R5CR123456X', rawState: 'unauthorized', model: null, transport: 'usb' },
    ]);
  });
});
