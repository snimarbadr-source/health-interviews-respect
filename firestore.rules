rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function signedIn() { return request.auth != null; }

    function userRole() {
      return signedIn()
        && exists(/databases/$(database)/documents/profiles/$(request.auth.uid))
        ? get(/databases/$(database)/documents/profiles/$(request.auth.uid)).data.role
        : null;
    }

    // Accept legacy role values too
    function isSuper() {
      return signedIn() && (userRole() in ['super','super_admin','superadmin']);
    }

    function isAdmin() {
      return signedIn() && (userRole() in ['super','admin','super_admin','superadmin']);
    }

    function isTrainer() {
      return signedIn() && (userRole() in ['super','admin','trainer','super_admin','superadmin']);
    }

    // --- Profiles ---
    // Each user may read/update their own profile, but cannot change their own role.
    // Admin/Super can manage all profiles; only Super can delete.
    match /profiles/{uid} {
      allow read: if signedIn() && (uid == request.auth.uid || isAdmin());

      allow create: if (signedIn() && uid == request.auth.uid) || isAdmin();

      allow update: if isAdmin()
        || (signedIn() && uid == request.auth.uid
            && !('role' in request.resource.data.diff(resource.data).affectedKeys()));

      allow delete: if isSuper();
    }

    // --- Candidates ---
    // Trainers (and Admin/Super) can read/write; only Admin/Super can delete.
    match /candidates/{docId} {
      allow read: if isTrainer();
      allow create, update: if isTrainer();
      allow delete: if isAdmin();
    }

    // --- Presence ---
    // Users can write their own presence; only Admin/Super can read presence list.
    match /presence/{uid} {
      allow create, update: if signedIn() && uid == request.auth.uid;
      allow read: if isAdmin();
      allow delete: if false;
    }

    // --- App config ---
    // Trainers can read config; only Admin/Super can write.
    match /config/{docId} {
      allow read: if isTrainer();
      allow create, update, delete: if isAdmin();
    }

    // --- System status ---
    // Signed-in users can read; only Admin/Super can write.
    match /system/{docId} {
      allow read: if signedIn();
      allow create, update, delete: if isAdmin();
    }

    // --- Audit ---
    // Any signed-in user can create logs; only Admin/Super can read.
    match /audit/{docId} {
      allow create: if signedIn();
      allow read: if isAdmin();
      allow update, delete: if false;
    }

    // Default deny
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
