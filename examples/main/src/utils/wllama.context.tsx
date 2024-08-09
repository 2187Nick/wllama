import { createContext, useContext, useMemo, useState } from 'react';
import {
  DebugLogger,
  getDefaultScreen,
  useDidMount,
  WllamaStorage,
} from './utils';
import { Wllama } from '@wllama/wllama';
import {
  DEFAULT_INFERENCE_PARAMS,
  LIST_MODELS,
  WLLAMA_CONFIG_PATHS,
} from '../config';
import {
  InferenceParams,
  RuntimeInfo,
  ManageModel,
  Model,
  ModelState,
  Screen,
} from './types';
import { verifyCustomModel } from './custom-models';
import { verifyLocalModel } from './local-models';

interface WllamaContextValue {
  // functions for managing models
  models: ManageModel[];
  downloadModel(model: ManageModel): Promise<void>;
  removeModel(model: ManageModel): Promise<void>;
  removeAllModels(): Promise<void>;
  isDownloading: boolean;
  isLoadingModel: boolean;
  currParams: InferenceParams;
  setParams(params: InferenceParams): void;

  // function to load/unload model
  currModel?: ManageModel;
  currRuntimeInfo?: RuntimeInfo;
  loadModel(model: ManageModel): Promise<void>;
  unloadModel(): Promise<void>;

  // function for managing custom user model
  addCustomModel(url: string): Promise<void>;
  removeCustomModel(model: ManageModel): Promise<void>;

  // function for managing local user model 
  addLocalModel(files: File[]): Promise<void>;

  // functions for chat completion
  getWllamaInstance(): Wllama;
  createCompletion(
    input: string,
    callback: (piece: string) => void
  ): Promise<void>;
  stopCompletion(): void;
  isGenerating: boolean;
  currentConvId: number;

  // nagivation
  navigateTo(screen: Screen, conversationId?: number): void;
  currScreen: Screen;
}

const WllamaContext = createContext<WllamaContextValue>({} as any);

let wllamaInstance = new Wllama(WLLAMA_CONFIG_PATHS, { logger: DebugLogger });
let stopSignal = false;
const resetWllamaInstance = () => {
  wllamaInstance = new Wllama(WLLAMA_CONFIG_PATHS, { logger: DebugLogger });
};

const getManageModels = async (): Promise<ManageModel[]> => {
  // TODO: remove "abandoned" files
  const cachedFiles = (await wllamaInstance.cacheManager.list()).filter((m) => {
    // remove files with sizes not matching remote
    return m.size === m.metadata.originalSize;
  });
  const cachedURLs = new Set(cachedFiles.map((e) => e.metadata.originalURL));
  const customModels = WllamaStorage.load('custom_models', []);
  const localModels = WllamaStorage.load('local_models', []);
  const models = [...LIST_MODELS, ...customModels, ...localModels];
  return models.map((m) => ({
    ...m,
    name: m.url
      .split('/')
      .pop()
      ?.replace(/-\d{5}-of-\d{5}/, '')
      .replace('.gguf', '') ?? '(unknown)',
    state: m.userAddedLocal
      ? ModelState.READY  // Local models are always considered ready
      : cachedURLs.has(m.url)
        ? ModelState.READY
        : ModelState.NOT_DOWNLOADED,
    downloadPercent: 0,
  }));
};

export const WllamaProvider = ({ children }: any) => {
  const [isGenerating, setGenerating] = useState(false);
  const [currentConvId, setCurrentConvId] = useState(-1);
  const [currScreen, setScreen] = useState<Screen>(getDefaultScreen());
  const [models, setModels] = useState<ManageModel[]>([]);
  const [isBusy, setBusy] = useState(false);
  const [currRuntimeInfo, setCurrRuntimeInfo] = useState<RuntimeInfo>();
  const [currParams, setCurrParams] = useState<InferenceParams>(
    WllamaStorage.load('params', DEFAULT_INFERENCE_PARAMS)
  );

  useDidMount(async () => {
    setModels(await getManageModels());
  });

  // computed variables
  const isDownloading = useMemo(
    () => models.some((m) => m.state === ModelState.DOWNLOADING),
    [models]
  );
  const isLoadingModel = useMemo(
    () => isBusy || models.some((m) => m.state === ModelState.LOADING),
    [models, isBusy]
  );
  const currModel = useMemo(
    () => models.find((m) => m.state === ModelState.LOADED),
    [models]
  );

  // utils
  const editModel = (newModel: ManageModel) =>
    setModels((models) =>
      models.map((m) => (m.url === newModel.url ? newModel : m))
    );
  const reloadModels = async () => {
    setModels(await getManageModels());
  };

  const downloadModel = async (model: ManageModel) => {
    if (isDownloading || currModel || isLoadingModel) return;
    editModel({ ...model, state: ModelState.DOWNLOADING, downloadPercent: 0 });
    try {
      await wllamaInstance.downloadModel(model.url, {
        progressCallback(opts) {
          editModel({
            ...model,
            state: ModelState.DOWNLOADING,
            downloadPercent: opts.loaded / opts.total,
          });
        },
      });
      editModel({ ...model, state: ModelState.READY, downloadPercent: 0 });
    } catch (e) {
      alert((e as any)?.message || 'unknown error while downloading model');
    }
  };

  const removeModel = async (model: ManageModel) => {
    if (model.userAdded) {
      const customModels = WllamaStorage.load<ManageModel[]>('custom_models', []);
      WllamaStorage.save('custom_models', customModels.filter(m => m.url !== model.url));
    }
    // If model card gets stuck. This helps to remove it from the UI
    if (model.userAddedLocal) {
      const localModels = WllamaStorage.load<ManageModel[]>('local_models', []);
      WllamaStorage.save('local_models', localModels.filter(m => m.url !== model.url));
    }

    if (!model.userAddedLocal) {
      // For all models (including built-in and custom remote models), attempt to remove from cache
      try {
        const cacheKey = await wllamaInstance.cacheManager.getNameFromURL(model.url);
        await wllamaInstance.cacheManager.delete(cacheKey);
      } catch (error) {
        console.warn(`Failed to remove model from cache: ${error}`);
      }
    }
    await reloadModels();
  };

  const removeAllModels = async () => {
    await wllamaInstance.cacheManager.deleteMany(() => true);
    await reloadModels();
  };

  const loadModel = async (model: ManageModel) => {
    if (isDownloading || currModel || isLoadingModel) return;
    // if this is custom model, we make sure that it's up-to-date
    if (model.userAdded) {
      await downloadModel(model);
    }
    // make sure the model is cached
    if ((await wllamaInstance.cacheManager.getSize(model.url)) <= 0) {
      throw new Error('Model is not in cache');
    }
    editModel({ ...model, state: ModelState.LOADING, downloadPercent: 0 });
    try {
      await wllamaInstance.loadModelFromUrl(model.url, {
        n_threads: currParams.nThreads > 0 ? currParams.nThreads : undefined,
        n_ctx: currParams.nContext,
        n_batch: currParams.nBatch,
      });
      editModel({ ...model, state: ModelState.LOADED, downloadPercent: 0 });
      setCurrRuntimeInfo({
        isMultithread: wllamaInstance.isMultithread(),
        hasChatTemplate: !!wllamaInstance.getChatTemplate(),
      });
    } catch (e) {
      resetWllamaInstance();
      alert(`Failed to load model: ${(e as any).message ?? 'Unknown error'}`);
      editModel({ ...model, state: ModelState.READY, downloadPercent: 0 });
    }
  };

  const unloadModel = async () => {
    if (!currModel) return;
    await wllamaInstance.exit();
    resetWllamaInstance();
    
    if (currModel.userAddedLocal) {
      // For local models, after unloading, remove the model from the list
      await removeLocalModel(currModel);
    } else {
      // For custom and built-in models, just change the state back to READY
      editModel({ ...currModel, state: ModelState.READY, downloadPercent: 0 });
    }
    
    setCurrRuntimeInfo(undefined);
  };

  const removeLocalModel = async (model: ManageModel) => {
    setBusy(true);
    try {
      const localModels = WllamaStorage.load<ManageModel[]>('local_models', []);
      WllamaStorage.save('local_models', localModels.filter(m => m.url !== model.url));
      
      // Remove the model card from the UI
      setModels(prevModels => prevModels.filter(m => m.url !== model.url));
    } catch (e) {
      console.error('Error removing local model:', e);
      throw e;
    } finally {
      setBusy(false);
    }
  };

  const createCompletion = async (
    input: string,
    callback: (currentText: string) => void
  ) => {
    if (isDownloading || !currModel || isLoadingModel) return;
    setGenerating(true);
    stopSignal = false;
    const result = await wllamaInstance.createCompletion(input, {
      nPredict: currParams.nPredict,
      useCache: true,
      sampling: {
        temp: currParams.temperature,
      },
      // @ts-ignore unused variable
      onNewToken(token, piece, currentText, optionals) {
        callback(currentText);
        if (stopSignal) optionals.abortSignal();
      },
    });
    callback(result);
    stopSignal = false;
    setGenerating(false);
  };

  const stopCompletion = () => {
    stopSignal = true;
  };

  const navigateTo = (screen: Screen, conversationId?: number) => {
    setScreen(screen);
    setCurrentConvId(conversationId ?? -1);
    if (screen === Screen.MODEL) {
      WllamaStorage.save('welcome', false);
    }
  };

  // proxy function for saving to localStorage
  const setParams = (val: InferenceParams) => {
    WllamaStorage.save('params', val);
    setCurrParams(val);
  };

  // function for managing custom user model
  const addCustomModel = async (url: string) => {
    setBusy(true);
    try {
      const custom = await verifyCustomModel(url);
      if (models.some((m) => m.url === custom.url)) {
        throw new Error('Model with the same URL already exist');
      }
      const currList: Model[] = WllamaStorage.load('custom_models', []);
      WllamaStorage.save('custom_models', [...currList, custom]);
      await reloadModels();
    } catch (e) {
      setBusy(false);
      throw e; // re-throw
    }
    setBusy(false);
  };

  const removeCustomModel = async (model: ManageModel) => {
    setBusy(true);
    await removeModel(model);
    const currList: Model[] = WllamaStorage.load('custom_models', []);
    WllamaStorage.save(
      'custom_models',
      currList.filter((m) => m.url !== model.url)
    );
    await reloadModels();
    setBusy(false);
  };

  // Skip caching and directly load the model from local files
  const loadLocalModel = async (files: File[]) => {
    try {
      await wllamaInstance.loadModel(files, {
        n_threads: currParams.nThreads > 0 ? currParams.nThreads : undefined,
        n_ctx: currParams.nContext,
        n_batch: currParams.nBatch,
      });
      
      const modelUrl = files[0].name.replace(/-\d{5}-of-\d{5}\.gguf$/, '');
      setModels(prevModels => 
        prevModels.map(m => 
          m.url === modelUrl 
            ? { ...m, state: ModelState.LOADED, downloadPercent: 1 } 
            : m
        )
      );
      
      setCurrRuntimeInfo({
        isMultithread: wllamaInstance.isMultithread(),
        hasChatTemplate: !!wllamaInstance.getChatTemplate(),
      });
    } catch (e) {
      resetWllamaInstance();
      alert(`Failed to load model: ${(e as any).message ?? 'Unknown error'}`);
    }
  };

  // Add local model then call loadLocalModel
  const addLocalModel = async (files: File[]) => {
    setBusy(true);
    try {
      const custom = await verifyLocalModel(files);
      const currList: Model[] = WllamaStorage.load('local_models', []);
      if (currList.some((m) => m.url === custom.url)) {
        throw new Error('Model with the same file name already exists');
      }
      const newModel: Model = {
        ...custom,
        userAdded: false,
        userAddedLocal: true,
      };
      WllamaStorage.save('local_models', [...currList, newModel]);
      
      await reloadModels();
      await loadLocalModel(files);
    } catch (e) {
      setBusy(false);
      throw e;
    }
    setBusy(false);
  };

  return (
    <WllamaContext.Provider
      value={{
        models,
        isDownloading,
        isLoadingModel,
        downloadModel,
        removeModel,
        removeAllModels,
        currModel,
        loadModel,
        unloadModel,
        currParams,
        setParams,
        createCompletion,
        stopCompletion,
        isGenerating,
        currentConvId,
        navigateTo,
        currScreen,
        getWllamaInstance: () => wllamaInstance,
        addCustomModel,
        removeCustomModel,
        addLocalModel,
        currRuntimeInfo,
      }}
    >
      {children}
    </WllamaContext.Provider>
  );
};

export const useWllama = () => useContext(WllamaContext);
