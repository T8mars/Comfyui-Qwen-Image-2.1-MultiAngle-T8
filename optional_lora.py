class AnyAngleOptionalLoRA:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model": ("MODEL",),
                             "lora_name": ("STRING", {"default": "QI2.1_AnyAngle.safetensors"}),
                             "strength_model": ("FLOAT", {"default": 1.0, "min": -100.0, "max": 100.0, "step": 0.01})}}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "load_lora"
    CATEGORY = "T8/AnyAngle"
    DESCRIPTION = "At strength 0, pass the Qwen base model through without requiring the AnyAngle LoRA file."

    def load_lora(self, model, lora_name, strength_model):
        if strength_model == 0:
            return (model,)
        if not isinstance(lora_name, str) or not lora_name.strip():
            raise ValueError("AnyAngle LoRA filename is empty")
        from nodes import LoraLoaderModelOnly
        if not hasattr(self, "_loader"):
            self._loader = LoraLoaderModelOnly()
        return self._loader.load_lora_model_only(model, lora_name, strength_model)
