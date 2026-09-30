import sys
from pathlib import Path
from types import ModuleType
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1]))
from optional_lora import AnyAngleOptionalLoRA


class OptionalLoRATests(unittest.TestCase):
    def test_base_mode_does_not_resolve_or_load_a_missing_lora(self):
        model = object()
        self.assertEqual(AnyAngleOptionalLoRA().load_lora(model, "not-installed.safetensors", 0), (model,))

    def test_nonzero_strength_delegates_to_comfy_loader(self):
        calls = []
        nodes = ModuleType("nodes")

        class Loader:
            def load_lora_model_only(self, model, name, strength):
                calls.append((model, name, strength))
                return ("loaded",)

        nodes.LoraLoaderModelOnly = Loader
        model = object()
        with patch.dict(sys.modules, {"nodes": nodes}):
            self.assertEqual(AnyAngleOptionalLoRA().load_lora(model, "QI2.1_AnyAngle.safetensors", 1), ("loaded",))
        self.assertEqual(calls, [(model, "QI2.1_AnyAngle.safetensors", 1)])

    def test_nonzero_strength_requires_a_filename(self):
        with self.assertRaisesRegex(ValueError, "filename is empty"):
            AnyAngleOptionalLoRA().load_lora(object(), "", 1)
