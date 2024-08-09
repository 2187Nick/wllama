import { Model } from './types';
import { WllamaStorage } from './utils';

const ggufMagicNumber = new Uint8Array([0x47, 0x47, 0x55, 0x46]);

export async function verifyLocalModel(files: File[]): Promise<Model> {
  return new Promise((resolve, reject) => {
    if (files.length === 0) {
      reject(new Error('No files selected'));
      return;
    }

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const arrayBuffer = event.target?.result as ArrayBuffer;
        const uint8Array = new Uint8Array(arrayBuffer);
        
        if (!checkBuffer(uint8Array.slice(0, 4), ggufMagicNumber)) {
          throw new Error('Not a valid gguf file: not starting with GGUF magic number');
        }

        const totalSize = files.reduce((sum, file) => sum + file.size, 0);

        // Use the name of the first file, removing the shard suffix if present
        const baseName = files[0].name.replace(/-\d{5}-of-\d{5}\.gguf$/, '');

        resolve({
          url: baseName,
          size: totalSize,
          userAddedLocal: true,
        });
      } catch (error) {
        reject(new Error(`Error reading file: ${error}`));
      }
    };

    reader.onerror = () => {
      reject(new Error('Error reading file'));
    };

    // Read only the first 4 bytes of the first file for the magic number check
    reader.readAsArrayBuffer(files[0].slice(0, 4));
  });
}


const checkBuffer = (buffer: Uint8Array, header: Uint8Array) => {
  for (let i = 0; i < header.length; i++) {
    if (header[i] !== buffer[i]) {
      return false;
    }
  }
  return true;
};

// for debugging only
// @ts-ignore
window._exportModelList = function () {
  const list: Model[] = WllamaStorage.load('local_models', []);
  const listExported = list.map((m) => {
    delete m.userAddedLocal;
    return m;
  });
  console.log(JSON.stringify(listExported, null, 2));
};
