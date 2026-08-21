# Localhost playback bridge input contract v1

Status: Phase 1確定  
Date: 2026-08-21  
Scope: `http://localhost:3000` / `http://127.0.0.1:3000` から拡張へ渡す単体clip・playlist再生handoff

## 1. 目的

localhost siteから受け取った値を、そのまま`chrome.storage.local`やplayback ownershipへ保存しない。bridge入口で正規化・検証・最小化し、正準snapshotだけを`BEGIN_PLAYBACK_HANDOFF`へ渡す。

この契約は次の3経路へ同じ規則を適用する。

- `clipSelected` CustomEvent: 現行siteの単体clip再生経路
- `window.postMessage({ type: "SET_CLIP_DATA" })`: 将来互換の単体clip経路。現行siteにはproducerがない
- `window.postMessage({ type: "PLAY_PLAYLIST_START" })` + `localStorage.playQueue`: 現行siteのplaylist経路

## 2. 正準データ

bridge通過後はキー名をcamelCaseへ統一する。入力に含まれる未知のキーは保存しない。

### 2.1 Canonical clip

```ts
type CanonicalClip = {
  clipId: number;           // 正のsafe integer
  service: "netflix" | "disneyplus";
  url: string;             // 検証済みHTTPS absolute URL
  startTime: number;       // finite、0以上
  endTime: number;         // finite、startTimeより大きい
  title?: string;          // 最大500文字
  clipname?: string;       // 最大500文字
  user?: string;           // 最大200文字
  username?: string;       // 最大200文字
  epnumber?: string;       // 最大200文字
};
```

`clipId`、`service`、`url`、`startTime`、`endTime`は必須。任意文字列はtrimし、空文字なら省略する。

### 2.2 Canonical playlist item

```ts
type CanonicalPlaylistItem = CanonicalClip & {
  id: number;              // clipIdと同じ値を互換目的で保持
  order: number;           // 0以上のsafe integer、queue内で一意
};
```

同じclipをplaylistへ複数回含めることは許可するため、`clipId`の重複は拒否しない。`order`の重複は拒否する。

## 3. 入力の正規化

### 3.1 ID

- `clipId`または`id`を受け付ける
- number、または10進数字だけのstringを正のsafe integerへ変換する
- 両方がある場合は同じ値でなければ拒否する
- `clipSelected`では`event.detail.clipId`を必須かつ正本とする
- `clipSelected`のcookieにも`clipId`がある場合、detailと一致しなければ拒否する。cookieだけの`clipId`では開始しない

### 3.2 時刻

次のaliasを受け付け、`startTime` / `endTime`へ統一する。

| Canonical | Accepted aliases |
|---|---|
| `startTime` | `startTime`, `starttime`, `StartTime` |
| `endTime` | `endTime`, `endtime`, `EndTime` |

numberまたは数値stringをfinite numberへ変換し、`0 <= startTime < endTime`を必須とする。`NaN`、`Infinity`、空文字は拒否する。

### 3.3 Service

受け付けるcanonical valueは`netflix`と`disneyplus`だけとする。大文字・小文字と空白を正規化し、`disney+` / `disney`は`disneyplus`へ変換する。

`prime`、`amazon`、`youtube`は現行utilityに定義があるが、manifestに再生content scriptがない。このためv1のmanaged playback handoffでは拒否する。対応する場合はmanifest、再生制御、smoke testを追加して契約versionを更新する。

### 3.4 URL

- 入力は1〜4096文字のstring
- 相対URLはserviceのbase URLを使って解決する
- 正規化後は`https:`のみ許可する
- username/password付きURLと明示portは拒否する
- serviceとhostnameが一致しなければ拒否する

| Service | Allowed hostname |
|---|---|
| `netflix` | `www.netflix.com` |
| `disneyplus` | `www.disneyplus.com` |

判定には文字列の前方一致ではなく`new URL()`の`protocol`、`hostname`、`port`を使う。

### 3.5 Order

- number、または10進数字だけのstringで、0以上のsafe integerを受け付ける
- 現行siteの`PlaylistView`は`order`を送らないため、欠落時だけ配列indexを補う
- 明示された不正値をindexへ置き換えて救済しない
- 正規化後に重複があればplaylist全体を拒否する

## 4. Cookie whitelist

`clipSelected`で読み取るcookie名は次だけとする。

- `title`
- `user`
- `url`
- `service`
- `clipId`
- `username`
- `startTime` / `starttime`
- `endTime` / `endtime`

それ以外のcookieは読み捨て、snapshotへ含めない。各cookieは個別に`decodeURIComponent`し、不正なpercent encodingはそのcookieを無効として扱う。必須項目が欠けた結果になればhandoff全体を拒否する。

cookieの`clipId`はevent detailとの整合確認専用であり、単独では再生対象IDの正本にしない。

## 5. Playlist制限

- 最小件数: 1
- 最大件数: 100
- 正規化後のqueueをUTF-8 JSONへシリアライズした最大サイズ: 524,288 bytes（512 KiB）
- raw `localStorage.playQueue`も同じ512 KiBを上限とし、上限確認後にだけ`JSON.parse`する

上限を超えた場合は一部を切り詰めず、playlist全体を拒否する。件数・サイズを増やす場合はsiteの実利用量、Chrome storage使用量、runtime messageサイズを計測して契約versionを更新する。

## 6. 経路別envelope

### 6.1 `clipSelected`

```js
window.dispatchEvent(new CustomEvent("clipSelected", {
  detail: {
    clipId: 123,
    requestId: "optional-correlation-id"
  }
}));
```

clip本体はwhitelist済みcookieとdetailから組み立てる。`detail.clipId`は必須。`requestId`は任意の1〜128文字stringで、結果通知以外には保存しない。

### 6.2 `SET_CLIP_DATA`

```js
window.postMessage({
  type: "SET_CLIP_DATA",
  requestId: "optional-correlation-id",
  payload: { clip: { /* CanonicalClip compatible input */ } }
}, window.location.origin);
```

`payload`と`payload.clip`はplain objectでなければ拒否する。

### 6.3 `PLAY_PLAYLIST_START`

```js
localStorage.setItem("playQueue", JSON.stringify(items));
window.postMessage({
  type: "PLAY_PLAYLIST_START",
  requestId: "optional-correlation-id"
}, window.location.origin);
```

`playQueue`は配列でなければならない。現行site itemの`{ id, clipname, title, service, Subtitles, url, startTime, endTime }`のうち、`Subtitles`は再生・コメント対象解決で未使用のため保存しない。`order`欠落時は配列indexを補う。

## 7. 拒否と結果通知

検証はall-or-nothingとする。1項目でも不正なら次をすべて行わない。

- `BEGIN_PLAYBACK_HANDOFF`
- ownership registry更新
- `chrome.storage.local`更新
- `sessionStorage` playback context更新
- Netflix / Disney+へのnavigation

bridgeは同一originのwindowへ、成功・失敗とも次のresult messageを1回返す。

```js
window.postMessage({
  type: "EXTENSION_PLAYBACK_HANDOFF_RESULT",
  requestId: "optional-correlation-id",
  source: "clipSelected", // または SET_CLIP_DATA / PLAY_PLAYLIST_START
  ok: false,
  reason: "invalid_time_range",
  field: "endTime",       // 任意
  index: 2                 // playlist itemの場合だけ任意
}, window.location.origin);
```

`reason`は次の安全な固定値だけを返す。

- `invalid_payload`
- `invalid_clip_id`
- `clip_id_mismatch`
- `invalid_service`
- `invalid_url`
- `invalid_time_range`
- `invalid_order`
- `duplicate_order`
- `empty_playlist`
- `queue_too_large`
- `payload_too_large`
- `handoff_failed`
- `background_unavailable`

consoleには`source`、`reason`、`field`、`index`だけを`console.warn`する。cookie値、token、raw URL、raw payloadは出力しない。

ユーザー通知はlocalhost siteがresult messageを受けて、値を含まない「再生データを確認できなかったため、クリップを開けませんでした。」を表示する。bridge自身は`alert`を出さない。site側がresult messageを表示する実装と結合確認はmerge blockerとする。

## 8. Backgroundでの再検証

content bridgeの検証だけを信頼境界にしない。`BEGIN_PLAYBACK_HANDOFF`を受けるbackgroundも、canonical clip / queue、件数、byte size、`context.clipId`との一致を同じ規則で再検証する。

contentとbackgroundが別実装で乖離しないよう、Phase 2では純粋なvalidatorをbundle可能な共通moduleへ置く。非bundleの`getClipData.js`から使えない場合は、manifest/webpack entryを変更して同じmoduleを利用できる構成へ寄せる。

## 9. 保存と消去

- storageへ保存するのは正準キーだけ
- ownerもpendingもなくなったglobal resetではmode flagだけでなく`clip`、`playQueue`、`nextClip`も消去する
- 新しいhandoffを拒否したとき、直前の有効なowner/snapshotは変更しない
- raw cookie objectとraw queueをログ・storage・ownership registryへ残さない

## 10. Phase 2の受入条件

- 3入力経路が同じcanonical validatorを通る
- 不正入力はbackgroundまで到達せず、backgroundへ直接送った不正snapshotも拒否される
- 正常な現行siteデータ例が正規化後のschemaに一致する
- 拒否時にstorage、registry、navigationへ部分更新がない
- 正常・異常・上限境界のunit testが追加される
- localhost siteがresult messageを表示できることをPhase 4で実Chrome確認する

## 11. 根拠と互換性

- 現行siteの単体再生はlegacy cookie（小文字`starttime` / `endtime`）と`clipSelected`を使う
- 現行siteのplaylist itemは`{ id, clipname, title, service, Subtitles, url, startTime, endTime }`で、`order`を持たない
- 現行siteに`SET_CLIP_DATA` producerはないため、これは将来互換経路として維持する
- コメント対象解決には正のserver clip IDが必須

site sourceはこのworkspaceに含まれないため、Phase 4でsite revisionと実payloadを照合する。実payloadがこの契約と異なる場合、validatorを緩めて黙認せず、site修正または契約version更新をレビューする。
