import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VkAdsClient } from "../client.js";
import { fail, ok, WRITE_CREATE } from "./util.js";

// Application limit, not a promise of VK's package-specific creative limits.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);

export function registerMediaTool(server: McpServer, client: VkAdsClient): void {
  server.registerTool("upload_image", {
    title: "Загрузить изображение для объявления",
    annotations: WRITE_CREATE,
    description: "Загружает JPEG/PNG через multipart в VK, возвращает фактические id и variants. Нужны base64 байты изображения (без data:), размеры и confirmWrite=true; только full. Не читает локальные файлы и не скачивает URL. В create_banner передайте content.<slot>={id}; слот зависит от package/banner pattern. При сетевой ошибке/5xx не повторять вслепую.",
    inputSchema: {
      imageBase64: z.string().min(4).max(MAX_BASE64_LENGTH).describe("Base64 JPEG/PNG, без data: префикса. Максимум 5 MiB исходных байтов. Не передавайте секреты."),
      width: z.number().int().min(1).max(16384).describe("Ширина исходного изображения в пикселях."),
      height: z.number().int().min(1).max(16384).describe("Высота исходного изображения в пикселях."),
      confirmWrite: z.boolean().describe("Требуется true: загрузка создаёт медиа в живом VK Ads."),
    },
  }, async ({ imageBase64, width, height, confirmWrite }) => {
    try {
      if (confirmWrite !== true) return fail("Загрузка — операция записи. Требуется confirmWrite=true.");
      if (imageBase64.length > MAX_BASE64_LENGTH || imageBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(imageBase64)) {
        return fail("Нужен корректный base64 JPEG/PNG размером не более 5 MiB.");
      }
      const bytes = Buffer.from(imageBase64, "base64");
      if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== imageBase64) {
        return fail("Нужен корректный base64 JPEG/PNG размером не более 5 MiB.");
      }
      const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpeg = bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      if (!png && !jpeg) return fail("Поддерживаются только байты JPEG/PNG, а не текст или credentials.");
      const form = new FormData();
      form.set("file", new Blob([bytes], { type: png ? "image/png" : "image/jpeg" }), png ? "creative.png" : "creative.jpg");
      form.set("data", JSON.stringify({ width, height }));
      const result = await client.post<{ id?: number; variants?: unknown }>("v2/content/static.json", form);
      if (!Number.isSafeInteger(result?.id) || Number(result.id) <= 0) {
        return fail("VK ответил на загрузку без корректного content ID. Не повторяйте автоматически: проверьте, был ли создан креатив.");
      }
      return ok(result);
    } catch (e) {
      return fail(e);
    }
  });
}
