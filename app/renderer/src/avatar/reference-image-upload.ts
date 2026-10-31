export interface AvatarReferenceImage {
  mimeType: 'image/png';
  data: string;
}

/** Normalise common browser image formats to the PNG accepted by the generation bridge. */
export async function readAvatarReference(file: File): Promise<AvatarReferenceImage> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
    throw new Error('Choose a PNG, JPEG or WebP image.');
  if (file.size > 25 * 1024 * 1024) throw new Error('Choose an image smaller than 25 MB.');
  const source = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the image.'));
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('Could not read the image.'));
    reader.readAsDataURL(file);
  });
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error('Could not open the image.'));
    image.onload = () => {
      try {
        if (
          !image.naturalWidth ||
          !image.naturalHeight ||
          image.naturalWidth > 4096 ||
          image.naturalHeight > 4096
        )
          throw new Error('Choose an image at most 4096 × 4096 pixels.');
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Could not prepare the image.');
        context.drawImage(image, 0, 0);
        const data = canvas.toDataURL('image/png').split(',')[1];
        if (!data || data.length > 35 * 1024 * 1024)
          throw new Error('The prepared image is too large. Choose a smaller image.');
        resolve({ mimeType: 'image/png', data });
      } catch (error) {
        reject(error);
      }
    };
    image.src = source;
  });
}
