const MIN_COMPRESS_SIZE = 300 * 1024;

export async function compressImage(
  file: File,
  maxDimension = 1280,
  quality = 0.82,
): Promise<File> {
  if (!file.type.startsWith("image/") || file.size < MIN_COMPRESS_SIZE) {
    return file;
  }
  if (!Number.isFinite(maxDimension) || maxDimension <= 0 || !Number.isFinite(quality)) {
    return file;
  }

  let objectUrl: string | undefined;
  try {
    const imageUrl = URL.createObjectURL(file);
    objectUrl = imageUrl;
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Unable to decode the selected image"));
      image.src = imageUrl;
    });

    const sourceWidth = image.naturalWidth;
    const sourceHeight = image.naturalHeight;
    if (sourceWidth === 0 || sourceHeight === 0) {
      return file;
    }

    const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) {
      return file;
    }

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", Math.min(1, Math.max(0, quality)));
    });
    if (!blob || blob.size === 0) {
      return file;
    }

    const baseName = file.name.replace(/\.[^.]+$/, "") || "photo";
    return new File([blob], `${baseName}.jpg`, {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  } finally {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }
  }
}
