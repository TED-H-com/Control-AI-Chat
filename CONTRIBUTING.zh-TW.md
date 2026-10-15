# 參與 Control AI Chat 貢獻

感謝您協助改善 Control AI Chat。您可以貢獻程式碼、測試、文件、翻譯、無障礙改善、可重現的錯誤報告，以及範圍明確的功能提案。使用方式與開發問題請在 <https://github.com/TED-H-com/Control-AI-Chat> 的討論區提出；已確認的錯誤與範圍明確的提案則請使用議題追蹤系統。

請勿在公開議題、討論或提取要求中通報安全性問題，應依 [`SECURITY.zh-TW.md`](SECURITY.zh-TW.md) 辦理。

參與本專案即表示您同意遵守 [`CODE_OF_CONDUCT.zh-TW.md`](CODE_OF_CONDUCT.zh-TW.md)。

## 開發環境

您需要 Node.js 24 與 npm。伺服器（`server/`）與網頁應用程式（`web/`）是兩個獨立的套件。

1. 安裝相依套件：

   ```bash
   (cd server && npm ci)
   (cd web && npm ci)
   ```

2. 建立 `server/.env`，寫入兩個開發用的金鑰。Git 會忽略這個檔案。

   ```bash
   printf 'JWT_SECRET=%s\nAUDIT_KEY=%s\n' "$(openssl rand -hex 48)" "$(openssl rand -hex 32)" > server/.env
   ```

3. 建立資料庫與第一個工作空間：

   ```bash
   cd server
   npm run migrate
   npm run build
   npm run bootstrap -- --workspace-name 'Development' --admin-email you@example.com
   ```

   最後一個指令會為該電子郵件地址產生一組密碼並顯示出來，而且只會顯示這一次。

4. 在連接埠 3010 啟動伺服器，再開另一個終端機視窗，在連接埠 5173 啟動網頁應用程式：

   ```bash
   (cd server && npm run dev)
   (cd web && npm run dev)
   ```

   開啟 http://localhost:5173 並登入。網頁應用程式會把 `/api` 的要求轉送給伺服器。

提出提取要求之前，請先執行下列檢查：

```bash
(cd server && npm test)
(cd web && npm test && npm run build && npm run i18n:check)
```

如果您修改了介面，也請執行畫面檢查（`npm run visual:audit`）。它會提供建置後的網頁應用程式，以 390、768 與
1440 像素三種寬度，擷取三種語言的每一個畫面並逐一檢查。它會模擬 API，因此不需要啟動伺服器。請將
`CHROMIUM_PATH` 設為 Chromium 或 Chrome 的執行檔路徑；未設定時畫面檢查會直接停止。若尚未安裝，可在 `web/`
執行 `npx playwright-core install chromium` 下載；`npx playwright-core install --dry-run chromium` 會顯示下載位置。

```bash
cd web
npm run build
npm run preview -- --port 4177 --strictPort &
CHROMIUM_PATH=/path/to/chrome npm run visual:audit
```

螢幕截圖會存放在 `web/visual-audit-output/`。

每一個新增的介面字串都必須提供三種語言：英文、繁體中文（台灣）與日文。缺少任何一種時，
`npm run i18n:check` 就會失敗。


## 開發者原始碼貢獻聲明

每一筆提交都必須包含 `Signed-off-by:` 行。請使用下列指令建立：

```text
git commit -s
```

簽署即表示您確認 [Developer Certificate of Origin 1.1](DCO)（開發者原始碼貢獻聲明 1.1 版）中的各項陳述，包括您有權提交該貢獻，且其公開紀錄得以保存及再散布。除非 DCO 允許，請勿代他人簽署。

本專案採「inbound = outbound」原則：除非檔案另有明確說明，所有貢獻均依專案所採用的同一份 [MIT 授權條款](LICENSE)提交。

## 來源與獨立開發

您只能貢獻：

* 自己的原創成果；或
* 依與 MIT 相容的開放原始碼授權條款提供，且您已保留所有必要著作權、姓名標示、授權及聲明檔案的素材。

請勿貢獻從下列來源複製或衍生的程式碼、文字、使用者介面設計、版面配置、螢幕截圖、提示詞、資料或文件：

* 專有產品；
* 機密資訊；或
* 只有在限制複製、逆向工程、基準測試或建造其他產品等條款下才能存取的服務。

即使您以客戶或員工身分合法存取該素材，本規則仍然適用。請勿在議題或提取要求中描述或引用其他廠商的產品，作為要求仿製的規格；請改為說明使用者需求及獨立開發的行為。

如無法確定來源或授權是否相容，請在貢獻前先詢問維護者。來源不明的貢獻，維護者得拒絕或移除。

## AI 輔助貢獻

本專案允許使用 AI 輔助，但您仍須對提交內容的每一行負責。您必須審閱並理解貢獻內容、確認自己有權提交，並檢查其正確性、安全性、授權問題、個資及秘密資訊。若大量使用 AI 輔助，必須在提取要求說明中揭露。

## 翻譯

所有面向使用者的字串都必須具備英文、繁體中文（台灣）及日文版本。請優先由母語使用者審閱，並與[法令遵循文件詞彙表](docs/compliance/README.zh-TW.md#詞彙表)用語保持一致。

## 法律與法令遵循文件

法律陳述應引用官方第一手來源，並說明法規狀態及資料截止日。不得陳述或暗示使用或設定 Control AI Chat 即可使營運者符合任何法律、標準或認證。

## 提取要求檢查表

建立或更新提取要求前，請確認：

- [ ] 相關測試與建置均已通過。
- [ ] 面向使用者的英文、繁體中文（台灣）及日文字串均已齊備。
- [ ] 每一筆提交都有必要的 `Signed-off-by:` 行。
- [ ] 貢獻內容不含認證資訊、權杖、金鑰或其他秘密。
- [ ] 測試資料、紀錄與螢幕截圖不含真實個資。
- [ ] 第三方素材採相容授權，且已保留所有必要聲明。
- [ ] 已在提取要求說明中揭露大量 AI 輔助。
