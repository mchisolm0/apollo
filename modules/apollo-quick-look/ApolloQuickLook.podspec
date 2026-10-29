require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'ApolloQuickLook'
  s.version = package['version']
  s.summary = 'Quick Look previews for Apollo attachments.'
  s.homepage = 'https://github.com/mchisolm0/apollo'
  s.license = { :type => 'MIT' }
  s.author = 'Apollo'
  s.platforms = { :ios => '16.1' }
  s.source = { :path => '.' }
  s.source_files = 'ios/**/*.swift'
  s.frameworks = 'QuickLook', 'UIKit'
  s.swift_version = '5.9'
  s.dependency 'ExpoModulesCore'
end
