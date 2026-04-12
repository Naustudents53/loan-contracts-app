document.addEventListener('DOMContentLoaded', function () {
  const canvas = document.getElementById('signature-canvas');
  if (!canvas) return;

  const container = canvas.parentElement;
  const feedbackEl = document.getElementById('signature-feedback');
  let pixelRatio = 1;
  let generatedSignatureData = null;

  function setFeedback(message, isError) {
    if (!feedbackEl) return;
    feedbackEl.textContent = message || '';
    feedbackEl.classList.toggle('text-danger-strong', Boolean(isError));
  }

  function drawDataUrlOnCanvas(dataUrl) {
    if (!dataUrl) return;

    const previewImage = new Image();
    previewImage.onload = function () {
      const context = canvas.getContext('2d');
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(previewImage, 0, 0);
      context.restore();
    };
    previewImage.src = dataUrl;
  }

  function getCurrentSignatureData() {
    if (!signaturePad.isEmpty()) {
      return signaturePad.toDataURL();
    }
    return generatedSignatureData;
  }

  function resizeCanvas() {
    const preservedSignatureData = getCurrentSignatureData();

    pixelRatio = Math.max(window.devicePixelRatio || 1, 1);
    canvas.width = container.offsetWidth * pixelRatio;
    canvas.height = 200 * pixelRatio;
    canvas.style.width = container.offsetWidth + 'px';
    canvas.style.height = '200px';
    canvas.getContext('2d').scale(pixelRatio, pixelRatio);
    signaturePad.clear();

    if (preservedSignatureData) {
      generatedSignatureData = preservedSignatureData;
      drawDataUrlOnCanvas(preservedSignatureData);
    }
  }

  const signaturePad = new SignaturePad(canvas, {
    backgroundColor: 'rgb(255, 255, 255)',
    penColor: 'rgb(0, 0, 0)',
  });

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Clear button
  const clearBtn = document.getElementById('clear-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      signaturePad.clear();
      generatedSignatureData = null;
      setFeedback('');
    });
  }

  canvas.addEventListener('pointerdown', function () {
    if (generatedSignatureData) {
      signaturePad.clear();
      generatedSignatureData = null;
    }
    setFeedback('');
  });

  const typedSignatureInput = document.getElementById('typed-signature');
  const applyTypedSignatureBtn = document.getElementById('apply-typed-signature');

  if (applyTypedSignatureBtn && typedSignatureInput) {
    applyTypedSignatureBtn.addEventListener('click', function () {
      const typedName = typedSignatureInput.value.trim();

      if (!typedName) {
        setFeedback('Escriba su nombre para generar la firma tipografica.', true);
        typedSignatureInput.focus();
        return;
      }

      const generatedCanvas = document.createElement('canvas');
      generatedCanvas.width = canvas.width;
      generatedCanvas.height = canvas.height;

      const generatedContext = generatedCanvas.getContext('2d');
      generatedContext.fillStyle = 'rgb(255, 255, 255)';
      generatedContext.fillRect(0, 0, generatedCanvas.width, generatedCanvas.height);
      generatedContext.fillStyle = 'rgb(28, 33, 44)';
      generatedContext.textAlign = 'center';
      generatedContext.textBaseline = 'middle';
      generatedContext.font = `${52 * pixelRatio}px "Brush Script MT", "Segoe Script", cursive`;
      generatedContext.fillText(typedName, generatedCanvas.width / 2, generatedCanvas.height / 2);

      generatedSignatureData = generatedCanvas.toDataURL('image/png');
      signaturePad.clear();
      drawDataUrlOnCanvas(generatedSignatureData);
      setFeedback('Firma tipografica aplicada. Puede enviar el contrato.', false);
    });
  }

  // Form submit
  const form = document.getElementById('sign-form');
  if (form) {
    form.addEventListener('submit', function (e) {
      if (signaturePad.isEmpty() && !generatedSignatureData) {
        e.preventDefault();
        setFeedback('Por favor, dibuje su firma o use la alternativa tipografica antes de enviar.', true);
        canvas.focus();
        return;
      }

      const signatureField = document.getElementById('signature-data');
      signatureField.value = signaturePad.isEmpty() ? generatedSignatureData : signaturePad.toDataURL();
      setFeedback('');
    });
  }
});
