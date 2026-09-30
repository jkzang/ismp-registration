from django.conf import settings
from django.contrib import admin
from django.urls import include, path
from rest_framework.routers import DefaultRouter

from registration import views

router = DefaultRouter()
router.register('chapters', views.ChapterViewSet, basename='chapter')
router.register('mentors', views.MentorViewSet, basename='mentor')
router.register('sheets', views.SheetViewSet, basename='sheet')
router.register('signups', views.SignupViewSet, basename='signup')

urlpatterns = [
    path('api/config/', views.ConfigView.as_view()),
    path('api/auth/me/', views.MeView.as_view()),
    path('api/auth/google/', views.GoogleLoginView.as_view()),
    path('api/auth/logout/', views.LogoutView.as_view()),
    path('api/', include(router.urls)),
]

if settings.DEBUG:
    urlpatterns.append(path('admin/', admin.site.urls))
