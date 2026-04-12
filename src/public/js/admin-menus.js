document.addEventListener('DOMContentLoaded', function () {
    try {
        if (typeof bootstrap !== 'undefined') {
            var tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
            tooltipTriggerList.map(function (tooltipTriggerEl) {
                return new bootstrap.Tooltip(tooltipTriggerEl);
            });
        }

        var forms = document.querySelectorAll('form.delete-menu-form, form.delete-menu-item-form');
        if (!forms || forms.length === 0) return;

        forms.forEach(function (form) {
            form.addEventListener('submit', function (e) {
                if (form.dataset && form.dataset.confirmed === '1') {
                    form.dataset.confirmed = '0';
                    return;
                }

                var message = form.getAttribute('data-confirm') || 'Are you sure you want to delete this item? This action cannot be undone.';

                if (typeof Swal === 'undefined' || !Swal.fire) {
                    if (!window.confirm(message)) {
                        e.preventDefault();
                    }
                    return;
                }

                e.preventDefault();
                e.stopPropagation();

                Swal.fire({
                    title: 'Are you sure?',
                    text: message,
                    icon: 'warning',
                    showCancelButton: true,
                    confirmButtonColor: '#d33',
                    cancelButtonColor: '#3085d6',
                    confirmButtonText: 'Yes, delete it!',
                    cancelButtonText: 'Cancel',
                    backdrop: true,
                    allowOutsideClick: false,
                    allowEscapeKey: false,
                    customClass: {
                        popup: 'swal2-popup',
                        title: 'swal2-title',
                        content: 'swal2-content',
                        actions: 'swal2-actions',
                        confirmButton: 'swal2-confirm',
                        cancelButton: 'swal2-cancel'
                    }
                }).then(function (result) {
                    if (result && result.isConfirmed) {
                        if (form.dataset) {
                            form.dataset.confirmed = '1';
                        }
                        form.submit();
                    }
                });
            });
        });
    } catch (err) {
        // fail silently to avoid breaking admin page
    }
});
