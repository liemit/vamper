document.addEventListener('DOMContentLoaded', function () {
  var textarea = document.getElementById('description');
  var editorContainer = document.getElementById('description-editor');

  if (textarea && editorContainer && window.Quill) {
    var quill = new window.Quill(editorContainer, {
      theme: 'snow',
      placeholder: textarea.getAttribute('placeholder') || 'Write something...',
      modules: {
        toolbar: {
          container: [
            [{ header: [1, 2, 3, false] }],
            ['bold', 'italic', 'underline', 'strike'],
            [{ align: [] }],
            [{ list: 'ordered' }, { list: 'bullet' }],
            [{ indent: '-1' }, { indent: '+1' }],
            ['link', 'image'],
            ['clean']
          ],
          handlers: {
            image: imageHandler
          }
        }
      }
    });

    function imageHandler() {
      var input = document.createElement('input');
      input.setAttribute('type', 'file');
      input.setAttribute('accept', 'image/*');
      input.setAttribute('multiple', 'multiple');
      input.click();

      input.onchange = function() {
        if (input.files && input.files.length > 0) {
          var formData = new FormData();
          var hasImage = false;
          
          for (var i = 0; i < input.files.length; i++) {
            if (/^image\//.test(input.files[i].type)) {
              formData.append('images', input.files[i]);
              hasImage = true;
            }
          }

          if (!hasImage) {
            alert('You can only upload images.');
            return;
          }
          
          var csrfToken = document.querySelector('input[name="_csrf"]');
          if (csrfToken) {
             formData.append('_csrf', csrfToken.value);
          }

          fetch('/employer/jobs/upload-image', {
            method: 'POST',
            body: formData,
            headers: {
              'Accept': 'application/json',
              'x-csrf-token': csrfToken ? csrfToken.value : ''
            }
          })
          .then(function(response) { 
             if (!response.ok) {
                return response.json().then(function(err) { throw err; });
             }
             return response.json(); 
          })
          .then(function(result) {
            if (result.ok && result.urls) {
              var range = quill.getSelection();
              var currentIndex = range ? range.index : 0;
              
              result.urls.forEach(function(url) {
                quill.insertEmbed(currentIndex, 'image', url);
                currentIndex++;
              });
              
              quill.setSelection(currentIndex);
            } else {
              alert('Image upload failed: ' + (result.error || 'Unknown error'));
            }
          })
          .catch(function(error) {
            console.error('Error:', error);
            alert('Image upload failed: ' + (error.error || error.message || 'Unknown error'));
          });
        }
      };
    }

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

  var thumbnailInput = document.getElementById('thumbnail');
  var previewContainer = document.getElementById('thumbnail-preview-container');

  if (thumbnailInput && previewContainer) {
    thumbnailInput.addEventListener('change', function () {
      var file = thumbnailInput.files && thumbnailInput.files[0];
      if (!file) {
        previewContainer.innerHTML = '<i class="bi bi-image text-muted fs-2"></i>';
        return;
      }

      var reader = new FileReader();
      reader.onload = function (e) {
        previewContainer.innerHTML = '<img src="' + e.target.result + '" style="width: 100%; height: 100%; object-fit: cover;" alt="Preview">';
      };
      reader.readAsDataURL(file);
    });
  }
});
