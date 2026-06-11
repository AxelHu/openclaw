import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const resolveFeishuSendTargetMock = vi.hoisted(() => vi.fn());
const resolveMarkdownTableModeMock = vi.hoisted(() => vi.fn(() => "preserve"));
const convertMarkdownTablesMock = vi.hoisted(() => vi.fn((text: string) => text));

vi.mock("./send-target.js", () => ({
  resolveFeishuSendTarget: resolveFeishuSendTargetMock,
}));

vi.mock("./runtime.js", () => ({
  setFeishuRuntime: vi.fn(),
  getFeishuRuntime: () => ({
    channel: {
      text: {
        resolveMarkdownTableMode: resolveMarkdownTableModeMock,
        convertMarkdownTables: convertMarkdownTablesMock,
      },
    },
  }),
}));

let sendMarkdownCardFeishu: typeof import("./send.js").sendMarkdownCardFeishu;
let sendStructuredCardFeishu: typeof import("./send.js").sendStructuredCardFeishu;

// Regression: 6/10 230099 was treated as a hard fail — the entire card
// message got dropped and the user saw only the "no-visible-reply"
// fallback. LLMs occasionally write the wrong open_id (typo / hallucinated
// hex / chat-cross-mix) and the only sane response is to fall back to a
// card with no mention chip but the same body text — the @name placeholder
// is already in the text from extractMentionTagsFromText.
describe("Feishu card send 230099 fallback (retry without @mentions)", () => {
  const replyMock = vi.fn();
  const createMock = vi.fn();

  beforeAll(async () => {
    ({ sendMarkdownCardFeishu, sendStructuredCardFeishu } = await import("./send.js"));
  });

  afterAll(() => {
    vi.doUnmock("./send-target.js");
    vi.doUnmock("./runtime.js");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resolveFeishuSendTargetMock.mockReturnValue({
      client: {
        im: {
          message: {
            reply: replyMock,
            create: createMock,
          },
        },
      },
      receiveId: "oc_chat_xxx",
      receiveIdType: "chat_id",
    });
  });

  it("retries without @mentions when markdown card hits 230099 (AxiosError shape)", async () => {
    const axiosError = Object.assign(new Error("Request failed with status code 400"), {
      response: {
        status: 400,
        data: {
          code: 230099,
          msg: "Failed to create card content, ext=ErrCode: 100290; ErrMsg: there is an invalid user resource (at/person) in your card; ErrorValue: ou_xxx;",
        },
      },
    });
    // First call (with mentions): reject with 230099
    // Second call (without mentions): succeed
    replyMock.mockRejectedValueOnce(axiosError).mockResolvedValueOnce({
      code: 0,
      data: { message_id: "om_retry_ok" },
    });

    const result = await sendMarkdownCardFeishu({
      cfg: {} as never,
      to: "chat:oc_chat_xxx",
      text: '<at user_id="ou_7b77a5e1fb89e58cb9b0febf427418a3">AxelHu</a> 黄金矿工：\n# 1. 主菜单进不去',
      replyToMessageId: "om_parent",
    });

    expect(replyMock).toHaveBeenCalledTimes(2);
    expect(result.messageId).toBe("om_retry_ok");

    // First call: with mentions array, body has <at id=...></at> prefix
    const firstCallBody = JSON.parse(replyMock.mock.calls[0][0].data.content);
    const firstMarkdown = firstCallBody.body.elements[0].content;
    expect(firstMarkdown).toContain("<at id=");
    expect(firstMarkdown).toContain("@AxelHu");

    // Second call (fallback): NO mentions array, body still has @AxelHu
    // but NO <at id=...></at> prefix
    const secondCallBody = JSON.parse(replyMock.mock.calls[1][0].data.content);
    const secondMarkdown = secondCallBody.body.elements[0].content;
    expect(secondMarkdown).not.toContain("<at id=");
    expect(secondMarkdown).toContain("@AxelHu");
  });

  it("retries without @mentions when markdown card hits 230099 (SDK error shape)", async () => {
    // SDK throws error with err.code directly (not AxiosError shape)
    const sdkError = Object.assign(new Error("Request failed"), { code: 230099 });
    replyMock.mockRejectedValueOnce(sdkError).mockResolvedValueOnce({
      code: 0,
      data: { message_id: "om_sdk_retry_ok" },
    });

    const result = await sendMarkdownCardFeishu({
      cfg: {} as never,
      to: "chat:oc_chat_xxx",
      text: '<at user_id="ou_7b77a5e1fb89e58cb9b0febf427418a3">AxelHu</a> 黄金矿工',
      replyToMessageId: "om_parent",
    });

    expect(replyMock).toHaveBeenCalledTimes(2);
    expect(result.messageId).toBe("om_sdk_retry_ok");
  });

  it("retries without @mentions when structured card hits 230099", async () => {
    const axiosError = Object.assign(new Error("Request failed with status code 400"), {
      response: { status: 400, data: { code: 230099, msg: "invalid user resource" } },
    });
    replyMock.mockRejectedValueOnce(axiosError).mockResolvedValueOnce({
      code: 0,
      data: { message_id: "om_structured_retry" },
    });

    const result = await sendStructuredCardFeishu({
      cfg: {} as never,
      to: "chat:oc_chat_xxx",
      text: '<at user_id="ou_bad_id">AxelHu</a> 重要发现',
      replyToMessageId: "om_parent",
      header: { title: "💻 Coder" },
    });

    expect(replyMock).toHaveBeenCalledTimes(2);
    expect(result.messageId).toBe("om_structured_retry");

    // Second call (fallback): NO <at id=...> in body
    const secondCallBody = JSON.parse(replyMock.mock.calls[1][0].data.content);
    const secondMarkdown = secondCallBody.body.elements[0].content;
    expect(secondMarkdown).not.toContain("<at id=");
    // Header is preserved
    expect(secondCallBody.header.title.content).toBe("💻 Coder");
  });

  it("does NOT retry for non-230099 errors (e.g. 99991401 permission denied)", async () => {
    const permError = Object.assign(new Error("permission denied"), { code: 99991401 });
    replyMock.mockRejectedValue(permError);

    await expect(
      sendMarkdownCardFeishu({
        cfg: {} as never,
        to: "chat:oc_chat_xxx",
        text: '<at user_id="ou_xxx">AxelHu</a> hello',
        replyToMessageId: "om_parent",
      }),
    ).rejects.toThrow("permission denied");

    // Only 1 call — no retry for non-230099 errors
    expect(replyMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry when first call succeeds (no false-positive fallback)", async () => {
    replyMock.mockResolvedValueOnce({
      code: 0,
      data: { message_id: "om_first_try" },
    });

    const result = await sendMarkdownCardFeishu({
      cfg: {} as never,
      to: "chat:oc_chat_xxx",
      text: '<at user_id="ou_good_id">AxelHu</a> 一切正常',
      replyToMessageId: "om_parent",
    });

    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(result.messageId).toBe("om_first_try");
  });

  it("preserves </a> drift fix on both attempts (regression: 94dcf90586f)", async () => {
    // The card with </a> drift would silently no-match extractMentionTagsFromText
    // BEFORE the 94dcf90586f fix. With the fix, the </a> becomes </at> on
    // the first try. If open_id is also bad, the fallback still gets the
    // cleaned text (no <at id=...> on fallback attempt).
    const axiosError = Object.assign(new Error("Request failed"), {
      response: { data: { code: 230099, msg: "invalid user resource" } },
    });
    replyMock.mockRejectedValueOnce(axiosError).mockResolvedValueOnce({
      code: 0,
      data: { message_id: "om_drift_retry" },
    });

    await sendMarkdownCardFeishu({
      cfg: {} as never,
      to: "chat:oc_chat_xxx",
      text: '<at user_id="ou_bad">AxelHu</a> 黄金矿工', // both </a> drift AND bad open_id
      replyToMessageId: "om_parent",
    });

    // First call: <at id=...> (drift fixed, but bad open_id) -> 230099
    const firstBody = JSON.parse(replyMock.mock.calls[0][0].data.content);
    expect(firstBody.body.elements[0].content).toContain("<at id=");
    expect(firstBody.body.elements[0].content).not.toContain("</a>"); // drift fixed
    // Second call: NO <at id=...> (mention dropped, text preserved)
    const secondBody = JSON.parse(replyMock.mock.calls[1][0].data.content);
    expect(secondBody.body.elements[0].content).not.toContain("<at id=");
    expect(secondBody.body.elements[0].content).toContain("@AxelHu");
    expect(secondBody.body.elements[0].content).toContain("黄金矿工");
  });
});
