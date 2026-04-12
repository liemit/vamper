document.addEventListener('DOMContentLoaded', function () {
  var textarea = document.getElementById('company-description');
  var editorContainer = document.getElementById('company-description-editor');

  if (textarea && editorContainer && window.Quill) {
    var quill = new window.Quill(editorContainer, {
      theme: 'snow',
      placeholder: textarea.getAttribute('placeholder') || 'Write something...',
      modules: {
        toolbar: [
          [{ header: [1, 2, 3, false] }],
          ['bold', 'italic', 'underline', 'strike'],
          [{ align: [] }],
          [{ list: 'ordered' }, { list: 'bullet' }],
          [{ indent: '-1' }, { indent: '+1' }],
          ['link'],
          ['clean']
        ]
      }
    });

    if (textarea.value) {
      quill.root.innerHTML = textarea.value;
    }

    var form = textarea.closest('form');
    if (form) {
      form.addEventListener('submit', function () {
        textarea.value = quill.root.innerHTML;
      });
    }
  }

  var logoInput = document.getElementById('logo');
  var previewContainer = document.getElementById('logo-preview-container');

  if (logoInput && previewContainer) {
    logoInput.addEventListener('change', function () {
      var file = logoInput.files && logoInput.files[0];
      if (!file) {
        previewContainer.innerHTML = '<i class="bi bi-image text-muted fs-2"></i>';
        return;
      }

      var reader = new FileReader();
      reader.onload = function (e) {
        previewContainer.innerHTML = '<img src="' + e.target.result + '" style="width: 100%; height: 100%; object-fit: cover;" alt="Company logo">';
      };
      reader.readAsDataURL(file);
    });
  }

  // Combined Profile and Change Password AJAX submission
  const mainForm = document.getElementById('mainProfileForm');
  const cpWrapper = document.getElementById('changePasswordWrapper');
  const mainSaveBtn = mainForm ? mainForm.querySelector('button[type="submit"]') : null;

  if (mainForm && cpWrapper) {
      mainForm.addEventListener('submit', async function (e) {
          const settingsTabItem = document.getElementById('pane-settings');
          const isSettingsActive = settingsTabItem && settingsTabItem.classList.contains('active');

          if (isSettingsActive) {
              e.preventDefault();
              
              const currentPass = cpWrapper.querySelector('input[name="current_password"]').value;
              const newPass = cpWrapper.querySelector('input[name="new_password"]').value;
              const confirmPass = cpWrapper.querySelector('input[name="confirm_new_password"]').value;

              const alertBox = document.getElementById('changePasswordAlert');
              
              if (!currentPass || !newPass || !confirmPass) {
                  alertBox.classList.remove('d-none', 'alert-success');
                  alertBox.classList.add('alert-danger');
                  alertBox.innerHTML = '<i class="bi bi-exclamation-triangle-fill me-2"></i>Please fill in all password fields.';
                  return;
              }

              if (mainSaveBtn) {
                  mainSaveBtn.disabled = true;
                  mainSaveBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>Saving...';
              }

              alertBox.classList.add('d-none');

              const data = {
                  current_password: currentPass,
                  new_password: newPass,
                  confirm_new_password: confirmPass,
                  _csrf: mainForm.querySelector('input[name="_csrf"]').value
              };

              try {
                  const res = await fetch('/employer/change-password', {
                      method: 'POST',
                      headers: {
                          'Content-Type': 'application/json',
                          'Accept': 'application/json',
                          'CSRF-Token': data._csrf || '',
                          'X-CSRF-Token': data._csrf || ''
                      },
                      body: JSON.stringify(data)
                  });
                  
                  const result = await res.json();
                  
                  if (!result.ok) {
                      let tabElement = document.querySelector('button[data-bs-target="#pane-settings"]');
                      if (tabElement) window.bootstrap && new window.bootstrap.Tab(tabElement).show();

                      alertBox.classList.remove('d-none', 'alert-success');
                      alertBox.classList.add('alert-danger');
                      alertBox.innerHTML = '<i class="bi bi-exclamation-triangle-fill me-2"></i>' + (result.error || 'Failed to update password.');
                      
                      if (mainSaveBtn) {
                          mainSaveBtn.disabled = false;
                          mainSaveBtn.innerHTML = '<i class="bi bi-save me-1"></i>Save changes';
                      }
                      return;
                  }
              } catch (err) {
                  let tabElement = document.querySelector('button[data-bs-target="#pane-settings"]');
                  if (tabElement) window.bootstrap && new window.bootstrap.Tab(tabElement).show();

                  alertBox.classList.remove('d-none', 'alert-success');
                  alertBox.classList.add('alert-danger');
                  alertBox.innerHTML = '<i class="bi bi-exclamation-triangle-fill me-2"></i>An error occurred. Please try again.';
                  
                  if (mainSaveBtn) {
                      mainSaveBtn.disabled = false;
                      mainSaveBtn.innerHTML = '<i class="bi bi-save me-1"></i>Save changes';
                  }
                  return;
              }
              
              cpWrapper.querySelector('input[name="current_password"]').value = '';
              cpWrapper.querySelector('input[name="new_password"]').value = '';
              cpWrapper.querySelector('input[name="confirm_new_password"]').value = '';

              alertBox.classList.remove('d-none', 'alert-danger');
              alertBox.classList.add('alert-success');
              alertBox.innerHTML = '<i class="bi bi-check-circle-fill me-2"></i>Password updated successfully!';
              
              if (mainSaveBtn) {
                  mainSaveBtn.disabled = false;
                  mainSaveBtn.innerHTML = '<i class="bi bi-save me-1"></i>Save changes';
              }
              
              // DO NOT submit main form native here. We only update password from this tab!
          } else {
              // If NOT on Settings tab, submit main form natively
              HTMLFormElement.prototype.submit.call(mainForm);
          }
      });
  }
});
