from rest_framework.permissions import BasePermission, IsAuthenticated


def chapter_of(user):
    profile = getattr(user, 'profile', None)
    return profile.chapter if profile else None


class InChapter(BasePermission):
    """Signed in with Google and part of a chapter; everything is scoped to that chapter."""
    message = 'Sign in and join a chapter first.'

    def has_permission(self, request, view):
        return bool(request.user.is_authenticated and request.user.is_active and chapter_of(request.user))


class SignedIn(IsAuthenticated):
    message = 'Sign in with your Google account first.'
